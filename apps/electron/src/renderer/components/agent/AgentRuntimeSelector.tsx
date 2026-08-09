import * as React from 'react'
import { Check, ChevronDown, Cpu, Server, Settings2 } from 'lucide-react'
import type { AgentRuntime, HermesPublicTarget } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { resolveHermesSwitchProtocol } from '@/lib/agent-runtime-switch'

interface AgentRuntimeSelectorProps {
  runtime: AgentRuntime
  currentTargetId?: string
  targets: HermesPublicTarget[]
  activeTargetId: string | null
  switching?: boolean
  onSelectPi: () => void
  onSelectHermes: (target: HermesPublicTarget) => void
  onManageHermes: () => void
}

/**
 * Pi-only 本地架构中的 external runtime 入口。
 * 选择另一 runtime/target 会创建并打开独立会话，不改写当前会话身份。
 */
export function AgentRuntimeSelector({
  runtime,
  currentTargetId,
  targets,
  activeTargetId,
  switching = false,
  onSelectPi,
  onSelectHermes,
  onManageHermes,
}: AgentRuntimeSelectorProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const currentTarget = targets.find((target) => target.id === currentTargetId)
  const isHermes = runtime === 'hermes-remote'
  const triggerLabel = isHermes
    ? `Hermes · ${currentTarget?.name ?? '远端'}`
    : 'Pi 本地'

  const selectPi = (): void => {
    setOpen(false)
    onSelectPi()
  }

  const selectHermes = (target: HermesPublicTarget): void => {
    setOpen(false)
    onSelectHermes(target)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              disabled={switching}
              data-agent-runtime-selector
              data-runtime={runtime}
              className="model-selector-trigger flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={`Agent Runtime：${triggerLabel}`}
            >
              {isHermes ? <Server className="size-3.5 shrink-0" /> : <Cpu className="size-3.5 shrink-0" />}
              <span className="max-w-[min(11rem,28vw)] truncate">{switching ? '正在切换…' : triggerLabel}</span>
              <ChevronDown className="size-3 shrink-0" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px]">
          <p>{isHermes ? '远端 Hermes Agent' : '本地 Pi Agent'}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">切换时新建独立会话，历史不会跨 Runtime 混用</p>
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[286px] p-1.5"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="px-2 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Agent Runtime
        </div>
        <Button
          type="button"
          variant="ghost"
          data-runtime-option="pi"
          aria-pressed={!isHermes}
          className={cn('h-auto w-full justify-start gap-2.5 rounded-md px-2.5 py-2 text-left', !isHermes && 'bg-accent')}
          onClick={selectPi}
        >
          <Cpu className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium">Pi 本地</span>
            <span className="block text-[10px] font-normal text-muted-foreground">Proma 本地 Agent，会话与文件保存在本机</span>
          </span>
          {!isHermes && <Check className="size-3.5 shrink-0 text-primary" />}
        </Button>

        <div className="my-1 h-px bg-border/70" />
        <div className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Hermes Remote
        </div>

        {targets.length === 0 ? (
          <div className="px-2.5 py-2 text-[11px] text-muted-foreground">尚未配置 Hermes 连接</div>
        ) : (
          targets.map((target) => {
            const current = isHermes && currentTargetId === target.id
            const protocol = resolveHermesSwitchProtocol(target)
            return (
              <Button
                key={target.id}
                type="button"
                variant="ghost"
                data-runtime-option="hermes-remote"
                data-hermes-target-id={target.id}
                aria-pressed={current}
                className={cn('h-auto w-full justify-start gap-2.5 rounded-md px-2.5 py-2 text-left', current && 'bg-accent')}
                onClick={() => selectHermes(target)}
              >
                <Server className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <span className="truncate">{target.name}</span>
                    {target.id === activeTargetId && !current && (
                      <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[9px] text-primary">默认</span>
                    )}
                  </span>
                  <span className="block text-[10px] font-normal text-muted-foreground">
                    {protocol === 'dashboard' ? 'Dashboard' : 'API Server'} · {target.mode === 'ssh-tunnel' ? 'SSH Tunnel' : 'Direct'}
                  </span>
                </span>
                {current && <Check className="size-3.5 shrink-0 text-primary" />}
              </Button>
            )
          })
        )}

        <div className="my-1 h-px bg-border/70" />
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-full justify-start gap-2 px-2.5 text-xs text-muted-foreground"
          onClick={() => {
            setOpen(false)
            onManageHermes()
          }}
        >
          <Settings2 className="size-3.5" />
          管理 Hermes 连接
        </Button>
      </PopoverContent>
    </Popover>
  )
}
