import SwiftUI
import UIKit

struct AccountSecurityView: View {
    enum Mode { case password, recoveryCode, recover }
    @ObservedObject var cloud: NativeCloudSync
    let mode: Mode
    @Environment(\.dismiss) private var dismiss
    @State private var username = ""
    @State private var currentPassword = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var recoveryCode = ""
    @State private var generatedCode = ""
    @State private var error = ""
    private var title: String { switch mode { case .password: return "修改密码"; case .recoveryCode: return "账号恢复码"; case .recover: return "恢复账号" } }
    var body: some View {
        Form {
            if mode == .recover {
                TextField("用户名", text: $username).textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
                SecureField("恢复码", text: $recoveryCode).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
            } else { SecureField("当前密码", text: $currentPassword).textContentType(.password).privacySensitive() }
            if mode != .recoveryCode {
                SecureField("新密码（至少 10 个字符）", text: $password).textContentType(.newPassword).privacySensitive()
                SecureField("确认新密码", text: $confirmation).textContentType(.newPassword).privacySensitive()
            }
            if !generatedCode.isEmpty {
                Section {
                    Text(generatedCode).font(.system(.body, design: .monospaced)).textSelection(.enabled).privacySensitive()
                    Button("复制恢复码") { UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: generatedCode]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)]) }
                } footer: { Text("仅显示这一次，请妥善保存。新恢复码会替换旧码。") }
            } else {
                Button(mode == .recoveryCode ? "生成恢复码" : "确认") { submit() }.disabled(cloud.busy)
                if mode == .recover { Text("需使用此前保存的恢复码。恢复后旧会话失效，恢复码只能使用一次。").font(.footnote).foregroundStyle(.secondary) }
            }
            if cloud.busy { ProgressView() }
            if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        .onAppear { username = cloud.user?.username ?? "" }
        .onDisappear { currentPassword = ""; password = ""; confirmation = ""; recoveryCode = ""; generatedCode = "" }
    }
    private func submit() {
        error = ""
        if mode != .recoveryCode {
            guard password == confirmation else { error = "两次密码不一致。"; return }
            guard (10...128).contains(password.count) else { error = "密码需为 10—128 个字符。"; return }
        }
        Task {
            do {
                switch mode {
                case .password: try await cloud.changePassword(currentPassword: currentPassword, newPassword: password); dismiss()
                case .recoveryCode: generatedCode = try await cloud.createRecoveryCode(password: currentPassword)
                case .recover: try await cloud.recoverAccount(username: username, recoveryCode: recoveryCode, newPassword: password); dismiss()
                }
            } catch { self.error = error.localizedDescription }
            currentPassword = ""; password = ""; confirmation = ""; recoveryCode = ""
        }
    }
}
