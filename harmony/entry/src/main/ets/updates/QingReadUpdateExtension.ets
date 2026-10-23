import { WorkSchedulerExtensionAbility, workScheduler } from '@kit.BackgroundTasksKit';
import { NativeUpdateRunner } from '../web/NativeUpdates';
import { UpdatePolicy } from '../web/UpdatePolicy';

export default class QingReadUpdateExtension extends WorkSchedulerExtensionAbility {
  private runner?: NativeUpdateRunner;

  onWorkStart(work: workScheduler.WorkInfo): void {
    if (work.workId !== UpdatePolicy.WORK_ID) return;
    if (this.runner !== undefined) this.runner.stop();
    const runner: NativeUpdateRunner = new NativeUpdateRunner(this.context); this.runner = runner;
    runner.run().catch((): void => {
      // Never log book titles, source URLs, account IDs, tokens or raw OS errors.
      console.warn('QingRead background update check did not finish');
    }).finally((): void => {
      if (this.runner !== runner) return;
      this.runner = undefined;
      try { workScheduler.stopWork(work, false); } catch (_) {}
    });
  }

  onWorkStop(work: workScheduler.WorkInfo): void {
    if (work.workId !== UpdatePolicy.WORK_ID) return;
    if (this.runner !== undefined) this.runner.stop();
    this.runner = undefined;
  }
}
