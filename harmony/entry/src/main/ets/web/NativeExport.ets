import { common } from '@kit.AbilityKit';
import { picker, fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { NativePolicy } from './NativePolicy';

interface ExportSession {
  id: string;
  name: string;
  path: string;
  expected: number;
  received: number;
  created: number;
}
interface BackupHeader { format: string; version: number }

export class NativeExport {
  private context: common.UIAbilityContext;
  private current?: ExportSession;
  private busy: boolean = false;
  private timer: number = -1;
  private encoder: util.TextEncoder = new util.TextEncoder();

  constructor(context: common.UIAbilityContext) { this.context = context; }

  begin(name: string, size: number): string {
    if (this.busy) throw new Error('请先关闭当前保存窗口');
    if (this.current !== undefined) throw new Error('已有备份正在导出');
    const safeName: string = NativePolicy.exportName(name);
    if (!Number.isInteger(size) || size < 1 || size > NativePolicy.MAX_EXPORT) {
      throw new Error('备份文件应小于 16 MB');
    }
    const id: string = util.generateRandomUUID();
    const path: string = this.context.cacheDir + '/qingread-export-' + id + '.part';
    const file: fileIo.File = fileIo.openSync(path, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE);
    fileIo.closeSync(file);
    this.current = { id: id, path: path, name: safeName, expected: size, received: 0, created: Date.now() };
    this.timer = setTimeout((): void => { this.cancel(id); }, 300000);
    return id;
  }

  private session(id: string): ExportSession {
    const session: ExportSession | undefined = this.current;
    if (session === undefined || id !== session.id || Date.now() - session.created > 300000 || this.busy) {
      throw new Error('备份导出已结束，请重新导出');
    }
    return session;
  }

  append(id: string, content: string): void {
    const session: ExportSession = this.session(id);
    if (typeof content !== 'string' || content.length === 0 || content.length > NativePolicy.MAX_CHUNK) {
      this.cancel(id); throw new Error('备份分块过大');
    }
    const bytes: Uint8Array = this.encoder.encodeInto(content);
    if (session.received + bytes.byteLength > session.expected) {
      this.cancel(id); throw new Error('备份大小与声明不一致');
    }
    const file: fileIo.File = fileIo.openSync(session.path, fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.APPEND);
    try {
      let written: number = 0;
      while (written < bytes.byteLength) {
        const count: number = fileIo.writeSync(file.fd, bytes.slice(written).buffer);
        if (count < 1) throw new Error('无法写入备份');
        written += count;
      }
      session.received += bytes.byteLength;
    } catch (_) {
      this.cancel(id); throw new Error('无法暂存备份，请重试');
    } finally {
      fileIo.closeSync(file);
    }
  }

  async commit(id: string, trusted: () => boolean): Promise<boolean> {
    const session: ExportSession = this.session(id);
    if (session.received !== session.expected) { this.cancel(id); throw new Error('备份内容尚未完整传输'); }
    try {
      const data: BackupHeader = JSON.parse(fileIo.readTextSync(session.path)) as BackupHeader;
      if (data === null || data.format !== 'qingread-backup' || data.version !== 1) {
        throw new Error('备份格式不正确');
      }
    } catch (_) {
      this.cancel(id); throw new Error('备份格式不正确');
    }
    this.busy = true;
    let destination: string = '';
    let ownsEmptyDestination: boolean = false;
    let target: fileIo.File | undefined;
    try {
      if (!trusted()) return false;
      const options: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
      options.newFileNames = [session.name];
      options.fileSuffixChoices = ['清读备份|.json'];
      // The system picker, not the web document, chooses the destination URI.
      const destinations: string[] = await new picker.DocumentViewPicker(this.context).save(options);
      if (destinations.length !== 1) return false;
      destination = destinations[0];
      // SavePicker creates a new empty file. Never truncate an existing non-empty file.
      target = fileIo.openSync(destination, fileIo.OpenMode.READ_WRITE);
      if (fileIo.statSync(target.fd).size !== 0) throw new Error('请选择新的备份文件名');
      ownsEmptyDestination = true;
      if (!trusted() || this.current !== session) return false;
      await fileIo.copyFile(session.path, target.fd);
      if (!trusted() || this.current !== session) return false;
      if (fileIo.statSync(target.fd).size !== session.expected) throw new Error('备份未完整保存');
      ownsEmptyDestination = false;
      return true;
    } catch (error) {
      // Cancellation has no selected file, and leaves no partial backup.
      if (destination === '') return false;
      throw new Error((error as Error).message || '无法保存备份，请重试');
    } finally {
      if (target !== undefined) { try { fileIo.closeSync(target); } catch (_) {} }
      if (ownsEmptyDestination && destination !== '') {
        try { fileIo.unlinkSync(destination); } catch (_) { /* The picker may already have removed it. */ }
      }
      this.busy = false;
      this.cancel(id);
    }
  }

  cancel(id: string): void {
    if (this.current === undefined || this.current.id !== id) return;
    const path: string = this.current.path;
    this.current = undefined;
    if (this.timer !== -1) clearTimeout(this.timer);
    this.timer = -1;
    try { fileIo.unlinkSync(path); } catch (_) { /* No data is retained after cancellation. */ }
  }

  dispose(): void {
    if (this.current !== undefined) this.cancel(this.current.id);
  }
}
