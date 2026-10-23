import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { picker } from '@kit.CoreFileKit';
import { BusinessError, deviceInfo } from '@kit.BasicServicesKit';
import { AppMetadata } from '../web/AppMetadata';
import { LocalOrigin } from '../web/LocalOrigin';
import { ResourceIndex } from '../web/ResourceIndex';

const BACK_SCRIPT: string = "(() => { if (window !== window.top || location.origin !== 'https://localhost') " +
  "return false; return typeof window.__qingreadHandleNativeBack === 'function' && " +
  "window.__qingreadHandleNativeBack() === true; })();";

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private resources: ResourceIndex = new ResourceIndex();
  private context?: common.UIAbilityContext;
  private attached: boolean = false;
  private alive: boolean = true;
  private handlingBack: boolean = false;
  private backRequestSerial: number = 0;
  private documentSerial: number = 0;
  private selectingFile: boolean = false;
  private foreground: boolean = true;
  @State private ready: boolean = false;
  @State private startupError: boolean = false;
  @State private scripts: ScriptItem[] = [];

  aboutToAppear(): void {
    this.alive = true;
    this.context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.prepare();
  }

  aboutToDisappear(): void {
    this.alive = false;
    this.attached = false;
    this.cancelPendingBack();
  }

  onPageShow(): void {
    this.foreground = true;
    this.emitLifecycle(true);
  }

  onPageHide(): void {
    this.foreground = false;
    this.cancelPendingBack();
    this.emitLifecycle(false);
  }

  private cancelPendingBack(): void {
    this.backRequestSerial++;
    this.handlingBack = false;
  }

  private emitLifecycle(active: boolean): void {
    if (!this.alive || !this.isLocalPage()) {
      return;
    }
    const script: string = active ?
      "if (window === window.top && location.origin === 'https://localhost') " +
      "window.dispatchEvent(new Event('qingread:harmony-active'));" :
      "if (window === window.top && location.origin === 'https://localhost') " +
      "window.dispatchEvent(new Event('qingread:harmony-background'));";
    try {
      this.controller.runJavaScript(script, (): void => {});
    } catch (_) {
      // Lifecycle events are best effort; OS suspension is not a background-task grant.
    }
  }

  private async prepare(): Promise<void> {
    try {
      const context: common.UIAbilityContext | undefined = this.context;
      if (context === undefined) {
        throw new Error('No application context');
      }
      this.resources.load(context);
      const script: string = await AppMetadata.documentScript();
      if (this.alive) {
        this.scripts = [{ script: script, scriptRules: [LocalOrigin.ORIGIN] }];
        this.ready = true;
      }
    } catch (_) {
      if (this.alive) {
        this.startupError = true;
      }
      console.error('QingRead packaged resources could not be loaded');
    }
  }

  private isLocalPage(): boolean {
    if (!this.attached) {
      return false;
    }
    try {
      return LocalOrigin.isAppPage(this.controller.getUrl());
    } catch (_) {
      return false;
    }
  }

  onBackPress(): boolean {
    if (!this.isLocalPage()) {
      return false;
    }
    if (this.handlingBack) {
      return true;
    }
    this.handlingBack = true;
    const requestSerial: number = ++this.backRequestSerial;
    try {
      this.controller.runJavaScript(BACK_SCRIPT, (error: BusinessError, result: string): void => {
        if (requestSerial !== this.backRequestSerial) {
          return;
        }
        this.handlingBack = false;
        if (!this.alive || !this.foreground || !this.isLocalPage()) {
          return;
        }
        if ((error && error.code) || result !== 'true') {
          this.backgroundApp();
        }
      });
    } catch (_) {
      this.handlingBack = false;
      this.backgroundApp();
    }
    return true;
  }

  private backgroundApp(): void {
    const context: common.UIAbilityContext | undefined = this.context;
    if (context === undefined) {
      return;
    }
    if (deviceInfo.sdkApiVersion >= 13) {
      context.moveAbilityToBackground().catch((): void => {
        console.error('QingRead could not move to background');
      });
    } else {
      // API 12 tablets cannot move an ability to the background. Exit the root page instead.
      context.terminateSelf().catch((): void => {
        console.error('QingRead could not close the root page');
      });
    }
  }

  private openExternal(value: string): void {
    const context: common.UIAbilityContext | undefined = this.context;
    if (context === undefined || !this.isLocalPage() || !LocalOrigin.isExternalHttps(value)) {
      return;
    }
    context.openLink(value, { appLinkingOnly: false }).catch((): void => {
      console.error('QingRead could not open external link');
    });
  }

  private response(status: number, mime: string): WebResourceResponse {
    const response: WebResourceResponse = new WebResourceResponse();
    response.setResponseCode(status);
    response.setReasonMessage(status === 200 ? 'OK' : 'Not Found');
    response.setResponseMimeType(mime);
    response.setResponseEncoding('utf-8');
    const headers: Header[] = [
      { headerKey: 'Cache-Control', headerValue: 'no-store' },
      { headerKey: 'X-Content-Type-Options', headerValue: 'nosniff' }
    ];
    response.setResponseHeader(headers);
    return response;
  }

  private intercept(request: WebResourceRequest): WebResourceResponse | null {
    const address: string = request.getRequestUrl();
    if (!LocalOrigin.isLoopbackRequest(address)) {
      return null;
    }
    const path: string | undefined = LocalOrigin.assetPath(address);
    const mime: string | undefined = path === undefined ? undefined : this.resources.mimeFor(path);
    if (path === undefined || mime === undefined || request.getRequestMethod() !== 'GET') {
      const missing: WebResourceResponse = this.response(404, 'text/plain');
      missing.setResponseData('Not Found');
      missing.setResponseIsReady(true);
      return missing;
    }
    const response: WebResourceResponse = this.response(200, mime);
    response.setResponseData($rawfile('web' + path));
    response.setResponseIsReady(true);
    return response;
  }

  private async selectFile(result: FileSelectorResult): Promise<void> {
    if (this.selectingFile || !this.isLocalPage() || this.context === undefined) {
      this.completeFileSelection(result, []);
      return;
    }
    this.selectingFile = true;
    const documentSerial: number = this.documentSerial;
    let selected: string[] = [];
    try {
      const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 1;
      options.fileSuffixFilters = ['阅读文件|.epub,.pdf,.txt,.json'];
      const documentPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(this.context);
      selected = await documentPicker.select(options);
    } catch (_) {
      // Cancellation and picker errors both complete the pending HTML input with no file.
    } finally {
      this.selectingFile = false;
      const canDeliver: boolean = this.alive && documentSerial === this.documentSerial && this.isLocalPage();
      this.completeFileSelection(result, canDeliver ? selected.slice(0, 1) : []);
    }
  }

  private completeFileSelection(result: FileSelectorResult, selected: string[]): void {
    try {
      result.handleFileList(selected);
    } catch (_) {
      // A picker may finish after the old Web document has been destroyed.
      console.error('QingRead file selection document is no longer available');
    }
  }

  build() {
    Column() {
      if (this.ready) {
        Web({ src: LocalOrigin.START_URL, controller: this.controller })
          .width('100%')
          .height('100%')
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .fileAccess(false)
          .geolocationAccess(false)
          .mixedMode(MixedMode.None)
          .javaScriptOnDocumentStart(this.scripts)
          .multiWindowAccess(true)
          .allowWindowOpenMethod(false)
          .onControllerAttached((): void => {
            this.attached = true;
            this.controller.setCustomUserAgent(this.controller.getUserAgent() + ' QingReadHarmony/1');
          })
          .onInterceptRequest((event: OnInterceptRequestEvent): WebResourceResponse | null => {
            return this.intercept(event.request);
          })
          .onLoadIntercept((event: OnLoadInterceptEvent): boolean => {
            if (!event.data.isMainFrame()) {
              return false;
            }
            const address: string = event.data.getRequestUrl();
            if (LocalOrigin.isAppPage(address)) {
              return false;
            }
            if (event.data.isRequestGesture()) {
              this.openExternal(address);
            }
            return true;
          })
          .onWindowNew((event: OnWindowNewEvent): void => {
            event.handler.setWebController(null);
            if (event.isUserTrigger) {
              this.openExternal(event.targetUrl);
            }
          })
          .onShowFileSelector((event: OnShowFileSelectorEvent): boolean => {
            this.selectFile(event.result);
            return true;
          })
          .onPageBegin((): void => {
            this.documentSerial++;
            this.cancelPendingBack();
          })
          .onPageEnd((): void => {
            this.emitLifecycle(this.foreground);
          })
          .onSslErrorEvent((event: SslErrorEvent): void => {
            event.handler.handleCancel();
          })
          .onPermissionRequest((event: OnPermissionRequestEvent): void => {
            event.request.deny();
          })
      } else if (this.startupError) {
        Text('无法打开清读，请重新安装完整应用。')
          .fontSize(16)
          .fontColor('#625D55')
          .padding(24)
      } else {
        LoadingProgress().width(28).height(28).color('#9B4B39')
      }
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#F7F4ED')
  }
}
