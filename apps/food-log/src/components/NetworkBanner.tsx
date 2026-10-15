import type { NetworkState } from '@/types'

export function NetworkBanner(props: { network: NetworkState; mock?: boolean }) {
  if (props.mock) {
    return (
      <div role="status" className="bg-muted px-4 py-1 text-center text-base font-semibold text-muted-foreground">
        本機試用，不會寫進試算表
      </div>
    )
  }
  if (props.network === 'unreachable' || props.network === 'offline') {
    return (
      <div role="status" className="bg-muted px-4 py-2 text-center font-semibold">
        連不到 Google 試算表
      </div>
    )
  }
  return null
}
