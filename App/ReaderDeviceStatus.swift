import SwiftUI
import UIKit

struct ReaderDeviceStatus: View {
    @State private var battery: Float = -1
    @State private var wasMonitoring = false
    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            HStack(spacing: 5) {
                Text(context.date, format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)).monospacedDigit()
                if battery >= 0 {
                    Image(systemName: battery > 0.8 ? "battery.100" : battery > 0.5 ? "battery.75" : battery > 0.25 ? "battery.50" : battery > 0.1 ? "battery.25" : "battery.0")
                        .accessibilityHidden(true)
                    Text("\(Int((battery * 100).rounded()))%").monospacedDigit()
                        .accessibilityLabel("电量 \(Int((battery * 100).rounded()))%")
                }
            }
        }
        .onAppear { wasMonitoring = UIDevice.current.isBatteryMonitoringEnabled; UIDevice.current.isBatteryMonitoringEnabled = true; battery = UIDevice.current.batteryLevel }
        .onReceive(NotificationCenter.default.publisher(for: UIDevice.batteryLevelDidChangeNotification)) { _ in battery = UIDevice.current.batteryLevel }
        .onDisappear { UIDevice.current.isBatteryMonitoringEnabled = wasMonitoring }
    }
}
