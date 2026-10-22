import Foundation
import UserNotifications
import BackgroundTasks
import UIKit
import ReadingCore

struct ReadingNotificationPreferences: Codable {
    var updates = false
    var downloads = false
}

@MainActor final class ReadingNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = ReadingNotifications()
    @Published private(set) var permission = UNAuthorizationStatus.notDetermined
    @Published var error: String?
    var openBook: ((String, String) -> Void)?
    func configure() {
        UNUserNotificationCenter.current().delegate = self
        refreshPermission()
    }
    func refreshPermission() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in Task { @MainActor in self.permission = settings.authorizationStatus } }
    }
    func authorize() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            refreshPermission(); return granted
        } catch { self.error = error.localizedDescription; return false }
    }
    func post(scope: String, book: Book, kind: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = book.title; content.body = body; content.sound = .default
        content.userInfo = ["bookID": book.id, "profileScope": scope]
        let request = UNNotificationRequest(identifier: "qingread." + scope + "." + kind + "." + UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }
    func clear(scope: String) {
        let center = UNUserNotificationCenter.current(), prefix = "qingread." + scope + "."
        center.getPendingNotificationRequests { requests in UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: requests.filter { $0.identifier.hasPrefix(prefix) }.map(\.identifier)) }
        center.getDeliveredNotifications { notifications in UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: notifications.filter { $0.request.identifier.hasPrefix(prefix) }.map { $0.request.identifier }) }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) { completionHandler([.banner, .sound]) }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let values = response.notification.request.content.userInfo
        Task { @MainActor in
            if let scope = values["profileScope"] as? String, let bookID = values["bookID"] as? String { self.openBook?(scope, bookID) }
            completionHandler()
        }
    }
}

@MainActor final class QingReadApplicationDelegate: NSObject, UIApplicationDelegate {
    static weak var store: AppStore?
    static let refreshIdentifier = "app.qingread.library-refresh"
    private var refreshOperation: Task<Void, Never>?
    private var refreshTask: BGAppRefreshTask?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard let store = Self.store else { return true }
        store.cloud.restoreSessionForBackground()
        ReadingNotifications.shared.configure()
        ReadingNotifications.shared.openBook = { [weak store] scope, id in store?.openNotificationBook(scope: scope, id: id) }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshIdentifier, using: nil) { [weak self] task in
            guard let task = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            Task { @MainActor in self?.runRefresh(task) }
        }
        store.startBackgroundDownloads()
        scheduleRefresh(enabled: store.notificationPreferences.updates)
        return true
    }
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier == BackgroundChapterDownloads.identifier, let store = Self.store else { completionHandler(); return }
        store.cloud.restoreSessionForBackground()
        store.handleBackgroundDownloadEvents(completion: completionHandler)
    }
    static func scheduleRefresh(enabled: Bool) {
        guard enabled else { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: refreshIdentifier); return }
        let request = BGAppRefreshTaskRequest(identifier: refreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
    private func scheduleRefresh(enabled: Bool) { Self.scheduleRefresh(enabled: enabled) }
    private func runRefresh(_ task: BGAppRefreshTask) {
        guard let store = Self.store, store.notificationPreferences.updates else { task.setTaskCompleted(success: true); return }
        Self.scheduleRefresh(enabled: true)
        refreshTask = task
        task.expirationHandler = { [weak self, weak store] in
            Task { @MainActor in
                self?.refreshOperation?.cancel(); store?.cancelBackgroundUpdateCheck()
                self?.finishRefresh(task, success: false)
            }
        }
        refreshOperation = Task {
            await store.checkShelfUpdates(maximumBooks: 3)
            self.finishRefresh(task, success: !Task.isCancelled)
        }
    }
    private func finishRefresh(_ task: BGAppRefreshTask, success: Bool) {
        guard refreshTask === task else { return }
        refreshTask = nil; refreshOperation = nil; task.setTaskCompleted(success: success)
    }
}
