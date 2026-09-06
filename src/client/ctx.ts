// Consume the target host declarations without bundling platform singletons.
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc, ConnectionRpcResult, ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

export type RpcResultLike<T> = ConnectionRpcResult<T>
export type RpcLike = ClientConnectionRpc
export type ClientCtx = Pick<Context, 'slots' | 'locale' | 'on' | 'effect'> & { connection: ConnectionHandle }
