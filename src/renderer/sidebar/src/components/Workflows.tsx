import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw, AlertTriangle, GitBranch, Moon, Square, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@common/components/Button'
import { cn } from '@common/lib/utils'

interface SessionSummary {
    eventCount: number
    uniqueUrls: number
    startedAt: string | null
}

interface GraphSummaryData {
    pageCount: number
    actionCount: number
    openLoopCount: number
    topPattern: string | null
    topSalientUrl: string | null
    likelyFinishAction: string | null
    startUrl: string | null
    lastUrl: string | null
}

const StatPill: React.FC<{ label: string; value: number | string }> = ({ label, value }) => (
    <div className="flex flex-col items-center px-3 py-2 rounded-lg bg-muted/60 dark:bg-muted/30 min-w-[60px]">
        <span className="text-base font-semibold text-foreground">{value}</span>
        <span className="text-[10px] text-muted-foreground mt-0.5">{label}</span>
    </div>
)

type Step = 'idle' | 'graph' | 'packet' | 'ready' | 'running'

type Autonomy = 'summarize' | 'prepare' | 'act'

export const Workflows: React.FC<{ onStarted?: () => void }> = ({ onStarted }) => {
    const [summary, setSummary] = useState<SessionSummary | null>(null)
    const [autonomy, setAutonomy] = useState<Autonomy>('prepare')
    const [step, setStep] = useState<Step>('idle')
    const [graphSummary, setGraphSummary] = useState<GraphSummaryData | null>(null)
    const [graphId, setGraphId] = useState<string | null>(null)
    const [packetGoal, setPacketGoal] = useState<string | null>(null)
    const [packetId, setPacketId] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const refreshSummary = useCallback(async () => {
        try {
            const next = await window.sidebarAPI.getSessionSummary()
            setSummary(next)
        } catch { /* best-effort */ }
    }, [])

    const syncAgentMode = useCallback(async () => {
        try {
            const r = await window.sidebarAPI.getAgentMode()
            if (r.mode === 'night') setStep('running')
        } catch { /* best-effort */ }
    }, [])

    useEffect(() => {
        void refreshSummary()
        void syncAgentMode()
        // also try to restore existing graph summary
        void window.sidebarAPI.getGraphSummary().then((r) => {
            if (r.ok) {
                setGraphSummary(r.summary)
                setGraphId(r.graphId)
                setStep((s) => s === 'idle' ? 'graph' : s)
            }
        }).catch(() => {})

        const interval = setInterval(() => {
            void refreshSummary()
        }, 3000)
        return () => clearInterval(interval)
    }, [refreshSummary, syncAgentMode])

    const run = async (fn: () => Promise<void>) => {
        setBusy(true)
        setError(null)
        try { await fn() } catch (e) {
            setError(e instanceof Error ? e.message : 'Something went wrong')
        } finally { setBusy(false) }
    }

    const handleBuildGraph = () => run(async () => {
        const r = await window.sidebarAPI.buildGraph()
        if (!r.ok) { setError(r.error); return }
        setGraphSummary(r.summary)
        setGraphId(r.graphId)
        setPacketGoal(null)
        setPacketId(null)
        setStep('graph')
    })

    const handleCompilePacket = () => run(async () => {
        const r = await window.sidebarAPI.compileTaskPacket()
        if (!r.ok) { setError(r.error); return }
        setPacketGoal(r.goal)
        setPacketId(r.packetId)
        setStep('packet')
    })

    const handleStart = () => run(async () => {
        const r = await window.sidebarAPI.startNightAgent(packetId ?? undefined, autonomy)
        if (!r.ok) { setError(r.error); return }
        setStep('running')
        onStarted?.()
    })

    const handleStop = async () => {
        await window.sidebarAPI.stopNightAgent()
        setStep(packetId ? 'ready' : graphId ? 'graph' : 'idle')
    }

    const handleClearData = () => run(async () => {
        await window.sidebarAPI.clearBehaviorData()
        setGraphSummary(null)
        setGraphId(null)
        setPacketGoal(null)
        setPacketId(null)
        setStep('idle')
        await refreshSummary()
    })

    const eventCount = summary?.eventCount ?? 0

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="max-w-3xl w-full mx-auto px-4 py-4 flex flex-col gap-4">

                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-semibold">Night Agent</h2>
                        <p className="text-xs text-muted-foreground">
                            {eventCount} events · {summary?.uniqueUrls ?? 0} pages observed
                        </p>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <Button variant="ghost" size="icon" onClick={refreshSummary} title="Refresh">
                            <RefreshCw className="size-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={handleClearData}
                            disabled={busy}
                            title="Clear all behavior data (events, graph, packets)"
                        >
                            <Trash2 className="size-4" />
                        </Button>
                    </div>
                </div>

                {/* Active banner */}
                {step === 'running' && (
                    <div className="rounded-xl border border-violet-500/40 bg-violet-500/10 p-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-sm text-violet-600 dark:text-violet-400">
                            <Moon className="size-4" />
                            <span className="font-medium">Night Agent running</span>
                            {packetGoal && (
                                <span className="text-xs opacity-70 truncate max-w-[160px]">{packetGoal}</span>
                            )}
                        </div>
                        <Button variant="outline" size="sm" onClick={handleStop}>
                            <Square className="size-3.5" />
                            Stop
                        </Button>
                    </div>
                )}

                {/* Graph summary */}
                {graphSummary && (
                    <div className="rounded-xl border border-border bg-background dark:bg-secondary/40 p-4 flex flex-col gap-3">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Behavior graph</div>
                        <div className="flex gap-2 flex-wrap">
                            <StatPill label="pages" value={graphSummary.pageCount} />
                            <StatPill label="actions" value={graphSummary.actionCount} />
                            <StatPill label="open loops" value={graphSummary.openLoopCount} />
                            {graphSummary.topPattern && (
                                <StatPill label="pattern" value={graphSummary.topPattern.split('/')[0]} />
                            )}
                        </div>
                        {graphSummary.likelyFinishAction && (
                            <p className="text-xs text-muted-foreground truncate">
                                Finish: {graphSummary.likelyFinishAction}
                            </p>
                        )}
                    </div>
                )}

                {/* Goal pill */}
                {packetGoal && (
                    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-foreground">
                        <span className="text-muted-foreground font-medium">Goal · </span>
                        {packetGoal}
                    </div>
                )}

                {/* Error */}
                {error && (
                    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400 flex items-start gap-2">
                        <AlertTriangle className="size-4 mt-0.5 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {/* Autonomy level — how much the night agent may do */}
                {step !== 'running' && (
                    <div className="flex items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground mr-0.5">Autonomy</span>
                        {(['summarize', 'prepare', 'act'] as const).map((lvl) => (
                            <button
                                key={lvl}
                                onClick={() => setAutonomy(lvl)}
                                className={cn(
                                    'px-2 py-1 rounded-md border capitalize transition-colors',
                                    autonomy === lvl
                                        ? 'border-violet-500 text-violet-600 dark:text-violet-400'
                                        : 'border-border text-muted-foreground hover:text-foreground'
                                )}
                            >
                                {lvl}
                            </button>
                        ))}
                    </div>
                )}

                {/* Action strip — single row, advances the pipeline */}
                {step !== 'running' && (
                    <div className="flex gap-2">
                        <Button
                            variant={step === 'idle' ? 'default' : 'outline'}
                            size="sm"
                            onClick={handleBuildGraph}
                            disabled={busy || eventCount === 0}
                            className="flex-1"
                        >
                            <GitBranch className="size-3.5" />
                            {busy && step === 'idle' ? 'Building…' : 'Build Graph'}
                        </Button>
                        <Button
                            variant={step === 'graph' ? 'default' : 'outline'}
                            size="sm"
                            onClick={handleCompilePacket}
                            disabled={busy || !graphId}
                            className="flex-1"
                        >
                            <Sparkles className="size-3.5" />
                            {busy && step === 'graph' ? 'Compiling…' : 'Compile'}
                        </Button>
                        <Button
                            variant={step === 'packet' || step === 'ready' ? 'default' : 'outline'}
                            size="sm"
                            onClick={handleStart}
                            disabled={busy || step === 'idle' || step === 'graph'}
                            className={cn('flex-1', (step === 'packet' || step === 'ready') && 'bg-violet-600 hover:bg-violet-700 text-white border-violet-600')}
                        >
                            <Moon className="size-3.5" />
                            {busy && (step === 'packet' || step === 'ready') ? 'Starting…' : 'Start'}
                        </Button>
                    </div>
                )}

            </div>
        </div>
    )
}
