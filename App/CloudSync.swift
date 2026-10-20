import Foundation
import SwiftUI
import Security
import ReadingCore

struct NativeCloudLocalState: Codable {
    var cursor = 0
    var revisions: [String: Int] = [:]
    var pending: [CloudMutation] = []
    var deferred: [String: CloudRecord] = [:]
}
private struct SavedCloudSession: Codable { let address: String; let session: CloudSession }
private enum CloudKeychain {
    static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.qingread.cloud", kSecAttrAccount as String: "session-v1"]
    static func load() -> Data? {
        var request=query;request[kSecReturnData as String]=true;request[kSecMatchLimit as String]=kSecMatchLimitOne
        var result: CFTypeRef?
        return SecItemCopyMatching(request as CFDictionary,&result)==errSecSuccess ? result as? Data : nil
    }
    static func save(_ data: Data) throws {
        let status=SecItemUpdate(query as CFDictionary,[kSecValueData as String:data] as CFDictionary)
        if status==errSecItemNotFound {
            var item=query;item[kSecValueData as String]=data;item[kSecAttrAccessible as String]=kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(item as CFDictionary,nil)==errSecSuccess else { throw AppError.message("登录信息未能保存到钥匙串。") };return
        }
        guard status==errSecSuccess else { throw AppError.message("登录信息未能保存到钥匙串。") }
    }
    static func clear() { SecItemDelete(query as CFDictionary) }
}
private final class CloudRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
final class NativeCloudSync: ObservableObject {
    @Published private(set) var user: CloudUser?
    @Published private(set) var busy=false
    @Published private(set) var message=""
    @Published private(set) var lastSync: Date?
    @Published private(set) var needsLogin=false
    @Published private(set) var files: [CloudFile] = []
    @Published private(set) var fileBusy = false
    @Published private(set) var fileMessage = ""
    @Published private(set) var usedBytes = 0
    @Published var address: String
    private weak var store: AppStore?
    private var session: CloudSession?
    private var sessionAddress=""
    private var local=NativeCloudLocalState()
    private var generation=UUID()
    private var started=false
    private var syncing=false
    private var debounce: Task<Void,Never>?
    private var polling: Task<Void,Never>?
    private var fileTask: Task<Void,Never>?
    private var downloads: [String:Task<Book,Error>] = [:]
    private let http=URLSession(configuration:.ephemeral,delegate:CloudRedirectGuard(),delegateQueue:nil)

    init(store: AppStore) {
        self.store=store
        address=UserDefaults.standard.string(forKey:"QingReadCloudServer") ?? (Bundle.main.object(forInfoDictionaryKey:"QingReadSyncServer") as? String ?? "")
    }
    private func normalized(_ value: String) throws -> String {
        guard var parts=URLComponents(string:value.trimmingCharacters(in:.whitespacesAndNewlines)), let host=parts.host, !host.isEmpty, parts.user==nil,parts.password==nil,
              parts.scheme=="https" || (parts.scheme=="http" && ["localhost","127.0.0.1","::1"].contains(host)) else { throw AppError.message("请填写可访问的 HTTPS 服务器地址。") }
        parts.query=nil;parts.fragment=nil
        var path=parts.path;while path.hasSuffix("/") { path.removeLast() }
        if !path.hasSuffix("/api") { path += "/api" };parts.path=path
        guard let result=parts.url?.absoluteString else { throw AppError.message("服务器地址无效。") };return result
    }
    func start() async {
        guard !started else { return };started=true
        if let data=CloudKeychain.load(),let saved=try? CloudJSON.decoder().decode(SavedCloudSession.self,from:data),let current=try? normalized(address),current==saved.address {
            do { try activate(saved.session,address:current) } catch { message=error.localizedDescription }
        }
        polling=Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds:20_000_000_000)
                guard !Task.isCancelled else { return }
                if UIApplication.shared.applicationState == .active { await self?.sync() }
            }
        }
        await sync()
    }
    private func activate(_ session: CloudSession,address: String) throws {
        generation=UUID();fileTask?.cancel();fileTask=nil;downloads.values.forEach { $0.cancel() };downloads=[:];files=[];fileBusy=false;fileMessage="";usedBytes=0
        try store?.selectCloudProfile(address+"|"+session.user.id)
        local=(try store?.loadCloudState()) ?? NativeCloudLocalState()
        // Reconcile the complete shelf on startup; pending operations are sent
        // first, so an offline edit is never replaced by the initial pull.
        local.cursor=0
        self.session=session;sessionAddress=address;user=session.user;needsLogin=false
        try replayPending()
    }
    private func request<T:Decodable>(_ path:String,body:Data?=nil,authenticated:Bool=true) async throws -> T {
        let endpoint=try normalized(address)
        if authenticated && endpoint != sessionAddress { throw AppError.message("服务器地址已更改，请重新登录。") }
        guard let url=URL(string:endpoint+path) else { throw AppError.message("服务器地址无效。") }
        var request=URLRequest(url:url,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:20)
        request.httpMethod=body==nil ? "GET":"POST";request.httpBody=body
        if body != nil { request.setValue("application/json",forHTTPHeaderField:"Content-Type") }
        let token=session?.token
        if authenticated,let token { request.setValue("Bearer "+token,forHTTPHeaderField:"Authorization") }
        let (data,response)=try await http.data(for:request)
        guard let response=response as? HTTPURLResponse else { throw AppError.message("同步响应无效。") }
        if !(200..<300).contains(response.statusCode) {
            if response.statusCode==401 && authenticated && token==session?.token { needsLogin=true }
            let error=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any]
            throw AppError.message(error?["message"] as? String ?? "同步服务暂时不可用。")
        }
        return try CloudJSON.decoder().decode(T.self,from:data)
    }
    func login(username:String,password:String,register:Bool) async throws {
        guard !busy else { return };busy=true;message="";defer { busy=false }
        let endpoint=try normalized(address)
        let data=try JSONSerialization.data(withJSONObject:["username":username,"password":password])
        let result:CloudSession=try await request(register ? "/auth/register":"/auth/login",body:data,authenticated:false)
        try CloudKeychain.save(CloudJSON.encoder().encode(SavedCloudSession(address:endpoint,session:result)))
        address=endpoint;UserDefaults.standard.set(endpoint,forKey:"QingReadCloudServer")
        try activate(result,address:endpoint)
        Task { @MainActor in await sync() }
    }
    func localChanged(_ action:CloudAction,book:Book) {
        guard user != nil,let store else { return }
        let previous=local.pending.first { $0.bookID==book.id }
        var actual=action
        if action == .progress && (previous?.action == .add || local.revisions[book.id]==nil) { actual = .add }
        let mutation=CloudMutation(action:actual,bookID:book.id,baseRevision:local.revisions[book.id] ?? 0,entry:actual == .remove ? nil:store.shelf.first { $0.id==book.id })
        local.pending.removeAll { $0.bookID==book.id };local.pending.append(mutation)
        do { try store.saveCloudState(local) } catch { message="同步队列保存失败：\(error.localizedDescription)" }
        debounce?.cancel();debounce=Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds:2_500_000_000)
            guard !Task.isCancelled else { return };await self?.sync()
        }
    }
    private func replayPending() throws {
        guard let store else { return }
        var shelf=store.shelf
        for mutation in local.pending {
            shelf.removeAll { $0.id==mutation.bookID }
            if mutation.action != .remove,let entry=mutation.entry { shelf.append(entry) }
        }
        try store.replaceCloudShelf(shelf)
    }
    func sync() async {
        guard session != nil,!needsLogin,!syncing,let store else { return }
        let current=generation;syncing=true;busy=true;message=""
        defer { syncing=false;if current==generation { busy=false } }
        do {
            for _ in 0..<40 {
                let request=CloudSyncRequest(cursor:local.cursor,mutations:Array(local.pending.prefix(50)))
                let snapshot:CloudSnapshot=try await self.request("/sync",body:CloudJSON.encoder().encode(request))
                guard current==generation else { return }
                guard snapshot.anchorFormat=="body-utf16-v1" else { throw AppError.message("服务器同步版本不兼容。") }
                let acknowledged=Set(snapshot.acknowledged)
                local.pending.removeAll { acknowledged.contains($0.id) }
                let pending=Set(local.pending.map(\.bookID))
                for record in snapshot.records where record.revision >= (local.revisions[record.bookID] ?? 0) { local.revisions[record.bookID]=record.revision;local.deferred[record.bookID]=record }
                var shelf=store.shelf
                for (id,record) in local.deferred where !pending.contains(id) {
                    shelf.removeAll { $0.id==id };if let entry=record.entry { shelf.append(entry) };local.deferred.removeValue(forKey:id)
                }
                try store.replaceCloudShelf(shelf)
                local.cursor=snapshot.cursor;try store.saveCloudState(local);lastSync=Date()
                if !snapshot.hasMore && local.pending.isEmpty { break }
            }
            if current==generation { syncFilesNow() }
        } catch { if current==generation { message="\(error.localizedDescription) 本地进度已保留。" } }
    }
    private func fileRequest(_ path: String) throws -> URLRequest {
        let endpoint=try normalized(address)
        guard endpoint==sessionAddress,let token=session?.token,let url=URL(string:endpoint+path) else { throw AppError.message("请先登录。") }
        var request=URLRequest(url:url,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:600)
        request.setValue("Bearer "+token,forHTTPHeaderField:"Authorization")
        return request
    }
    private func checkFileResponse(_ response:URLResponse) throws {
        guard let http=response as? HTTPURLResponse else { throw AppError.message("文件响应无效。") }
        guard http.statusCode==200 else { throw AppError.message(http.statusCode==404 ? "云端文件尚未上传。":http.statusCode==413 ? "云文件空间或单本大小超限。":http.statusCode==429 ? "文件同步正忙，请稍后重试。":"文件同步失败（\(http.statusCode)）。") }
    }
    private func fileList(_ current:UUID) async throws -> CloudFileSnapshot {
        let snapshot:CloudFileSnapshot=try await request("/files")
        if current==generation { files=snapshot.files;usedBytes=snapshot.usedBytes }
        return snapshot
    }
    func syncFilesNow() {
        guard session != nil,!needsLogin,fileTask==nil else { return }
        let current=generation
        fileTask=Task { @MainActor [weak self] in
            guard let self,let store=self.store else { return }
            self.fileBusy=true;self.fileMessage=""
            defer { if current==self.generation { self.fileBusy=false;self.fileTask=nil } }
            do {
                var snapshot=try await self.fileList(current)
                for entry in store.shelf {
                    try Task.checkCancellation();guard current==self.generation else { return }
                    let book=entry.book
                    guard let hash=book.fileHash,book.publicationFormat != nil,!snapshot.files.contains(where:{$0.hash==hash}),let url=store.publicationURL(for:book) else { continue }
                    let bytes=try url.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? 0
                    guard bytes<=snapshot.maxFileBytes else { throw AppError.message("文件超过云端单本上限。") }
                    var query=URLComponents();query.queryItems=[URLQueryItem(name:"bookID",value:book.id),URLQueryItem(name:"bytes",value:String(bytes))]
                    var upload=try self.fileRequest("/files/"+hash+"?"+(query.percentEncodedQuery ?? ""));upload.httpMethod="POST";upload.setValue("application/octet-stream",forHTTPHeaderField:"Content-Type")
                    self.fileMessage="正在上传 "+book.title
                    let (_,response)=try await self.http.upload(for:upload,fromFile:url);try self.checkFileResponse(response)
                    guard current==self.generation else { return };snapshot=try await self.fileList(current)
                }
                if current==self.generation { self.fileMessage="" }
            } catch { if current==self.generation && !Task.isCancelled { self.fileMessage=error.localizedDescription } }
        }
    }
    func downloadPublication(_ book:Book) async throws -> Book {
        if let pending=downloads[book.id] { return try await pending.value }
        let current=generation
        let task=Task { @MainActor () throws -> Book in
            guard let hash=book.fileHash,let format=book.publicationFormat,let store else { throw AppError.message("云端文件尚未同步。") }
            let request=try fileRequest("/files/"+hash)
            let (temporary,response)=try await http.download(for:request)
            defer { try? FileManager.default.removeItem(at:temporary) }
            try checkFileResponse(response);try Task.checkCancellation()
            guard current==generation else { throw CancellationError() }
            return try await store.importPublication(at:temporary,format:format,metadata:book)
        }
        downloads[book.id]=task
        defer { if current==generation { downloads.removeValue(forKey:book.id) } }
        return try await task.value
    }
    func cancelDownload(_ book:Book) { downloads[book.id]?.cancel() }
    func mergeGuest() async throws { guard user != nil else { return };try store?.mergeGuestLibrary();await sync() }
    func logout() async {
        generation=UUID();debounce?.cancel();fileTask?.cancel();fileTask=nil;downloads.values.forEach { $0.cancel() };downloads=[:];files=[];fileBusy=false;fileMessage="";usedBytes=0
        struct Result:Decodable { let ok:Bool }
        let _:Result?=try? await request("/auth/logout",body:Data("{}".utf8))
        CloudKeychain.clear();session=nil;user=nil;local=NativeCloudLocalState();needsLogin=false;message="";lastSync=nil
        do { try store?.selectCloudProfile(nil) } catch { message=error.localizedDescription };busy=false
    }
}

struct CloudAccountView: View {
    @ObservedObject var cloud: NativeCloudSync
    @State private var username=""
    @State private var password=""
    @State private var confirmation=""
    @State private var register=false
    @State private var error=""
    @State private var relogin=false
    var body: some View {
        Form {
            if let user=cloud.user,!relogin {
                Section("当前账号") {
                    Text(user.username).font(.headline)
                    Text("书架和阅读进度只同步到这个账号。").font(.footnote)
                    if let date=cloud.lastSync { Text("上次同步 \(date.formatted(date:.omitted,time:.shortened))").font(.footnote) }
                    Button(cloud.needsLogin ? "重新登录":"立即同步") { if cloud.needsLogin { username=user.username;relogin=true } else { Task { await cloud.sync() } } }.disabled(cloud.busy)
                    Button("合并本机未登录书架") { Task { do { try await cloud.mergeGuest() } catch { self.error=error.localizedDescription } } }.disabled(cloud.busy)
                    Button("退出账号，返回本机书架",role:.destructive) { Task { await cloud.logout() } }.disabled(cloud.busy)
                }
            } else {
                Section("同步服务器") { TextField("https://你的服务器",text:$cloud.address).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL) }
                Section(register ? "创建账号":"登录账号") {
                    TextField("用户名",text:$username).textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
                    SecureField("密码（至少 10 个字符）",text:$password).textContentType(register ? .newPassword:.password)
                    if register { SecureField("确认密码",text:$confirmation).textContentType(.newPassword) }
                    Button(register ? "注册并登录":"登录") {
                        error=""
                        if register && password != confirmation { error="两次密码不一致。";return }
                        Task {
                            do { try await cloud.login(username:username,password:password,register:register);relogin=false }
                            catch { self.error=error.localizedDescription }
                            password="";confirmation=""
                        }
                    }.disabled(cloud.busy)
                    Button(register ? "已有账号，去登录":"没有账号，创建一个") { register.toggle();error="" }

                }
            }
            if cloud.user != nil {
                Section("云文件") {
                    Text("\(cloud.files.count) 本 · \(ByteCountFormatter.string(fromByteCount:Int64(cloud.usedBytes),countStyle:.file))")
                    Button(cloud.fileBusy ? "文件同步中…":"同步文件") { cloud.syncFilesNow() }.disabled(cloud.fileBusy)
                    if !cloud.fileMessage.isEmpty { Text(cloud.fileMessage).font(.footnote) }
                }
            }
            if cloud.busy { ProgressView("正在连接…") }
            if !cloud.message.isEmpty { Section { Text(cloud.message).font(.footnote) } }
            if !error.isEmpty { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
        }.navigationTitle("账号与同步").navigationBarTitleDisplayMode(.inline)
    }
}
