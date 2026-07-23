/** 错误上报的唯一出口:领域操作抛出的错误以 toast 直接可见,不吞错。 */
import { ServerResponseError } from '@/client/app-server-client';
import { toast } from '@/components/ui/Toasts';

export function reportError(error: unknown): void {
  if (error instanceof ServerResponseError) {
    toast.danger('服务端拒绝了请求', error.rpcError.message);
    return;
  }
  if (error instanceof Error) {
    toast.danger('操作失败', error.message);
    return;
  }
  toast.danger('操作失败', String(error));
}

/** 运行领域操作:先展示错误,再原样抛出,调用链保持失败状态。 */
export async function runOperation<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    reportError(error);
    throw error;
  }
}
