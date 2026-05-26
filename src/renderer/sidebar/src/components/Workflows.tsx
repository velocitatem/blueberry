import React, { useCallback, useEffect, useState } from 'react'
import { Sparkles, RefreshCw, Trash2, AlertTriangle, Copy } from 'lucide-react'
import { Button } from '@common/components/Button'
import { cn } from '@common/lib/utils'

interface SessionSummary {
    eventCount: number
    uniqueUrls: number
    startedAt: string | null
}

interface CompiledWorkflow {
    goal: string
    steps: string[]
    extractedEntities: string[]
    automationPrompt: string
    riskLevel: 'low' | 'medium' | 'high'
    riskWarnings: string[]
    repeatabilityScore: number
}

const RISK_STYLES: Record<CompiledWorkflow['riskLevel'], string> = {
    low: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    medium: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    high: 'bg-red-500/10 text-red-600 dark:text-red-400',
}

const SectionCard: React.FC<{ title: string; children: React.ReactNode }> = ({
    title,
    children,
}) => (
    <div className="rounded-xl border border-border bg-background dark:bg-secondary/40 p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            {title}
        </div>
        {children}
    </div>
)

export const Workflows: React.FC = () => {
    const [summary, setSummary] = useState<SessionSummary | null>(null)
    const [workflow, setWorkflow] = useState<CompiledWorkflow | null>(null)
    const [isCompiling, setIsCompiling] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const refreshSummary = useCallback(async () => {
        try {
            const next = await window.sidebarAPI.getSessionSummary()
            setSummary(next)
        } catch (e) {
            // best-effort
        }
    }, [])

    useEffect(() => {
        void refreshSummary()
        const interval = setInterval(refreshSummary, 2500)
        return () => clearInterval(interval)
    }, [refreshSummary])

    const handleCompile = async () => {
        setIsCompiling(true)
        setError(null)
        try {
            const result = await window.sidebarAPI.compileWorkflow()
            if (result.ok) {
                setWorkflow(result.workflow)
            } else {
                setError(result.error)
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Compile failed')
        } finally {
            setIsCompiling(false)
        }
    }

    const handleClear = async () => {
        await window.sidebarAPI.clearSession()
        setWorkflow(null)
        setError(null)
        await refreshSummary()
    }

    const copyAutomationPrompt = async () => {
        if (!workflow) return
        try {
            await navigator.clipboard.writeText(workflow.automationPrompt)
        } catch {
            // ignore
        }
    }

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="max-w-3xl w-full mx-auto px-4 py-4 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-semibold">Night Shift Handover</h2>
                        <p className="text-xs text-muted-foreground">
                            Compile browsing into a reusable workflow.
                        </p>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={refreshSummary}
                        title="Refresh"
                    >
                        <RefreshCw className="size-4" />
                    </Button>
                </div>

                <SectionCard title="Observed session">
                    <div className="flex items-center justify-between gap-3">
                        <div className="text-sm text-foreground">
                            <span className="font-medium">
                                {summary?.eventCount ?? 0}
                            </span>{' '}
                            events ·{' '}
                            <span className="font-medium">
                                {summary?.uniqueUrls ?? 0}
                            </span>{' '}
                            pages
                        </div>
                        <div className="flex gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleClear}
                                title="Clear session"
                            >
                                <Trash2 className="size-3.5" />
                                Clear
                            </Button>
                            <Button
                                size="sm"
                                onClick={handleCompile}
                                disabled={isCompiling || (summary?.eventCount ?? 0) === 0}
                            >
                                <Sparkles className="size-3.5" />
                                {isCompiling ? 'Compiling…' : 'Compile Session'}
                            </Button>
                        </div>
                    </div>
                </SectionCard>

                {error && (
                    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400 flex items-start gap-2">
                        <AlertTriangle className="size-4 mt-0.5 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {workflow && (
                    <>
                        <SectionCard title="Inferred goal">
                            <div className="text-sm text-foreground">{workflow.goal}</div>
                            <div className="mt-2 flex items-center gap-2">
                                <span
                                    className={cn(
                                        'text-xs px-2 py-0.5 rounded-full font-medium',
                                        RISK_STYLES[workflow.riskLevel]
                                    )}
                                >
                                    risk: {workflow.riskLevel}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    repeatability:{' '}
                                    {(workflow.repeatabilityScore * 100).toFixed(0)}%
                                </span>
                            </div>
                        </SectionCard>

                        <SectionCard title="Reusable steps">
                            <ol className="list-decimal pl-5 space-y-1 text-sm text-foreground">
                                {workflow.steps.map((step, i) => (
                                    <li key={i}>{step}</li>
                                ))}
                            </ol>
                        </SectionCard>

                        {workflow.extractedEntities.length > 0 && (
                            <SectionCard title="Data extracted">
                                <div className="flex flex-wrap gap-1.5">
                                    {workflow.extractedEntities.map((e, i) => (
                                        <span
                                            key={i}
                                            className="text-xs px-2 py-0.5 rounded-full bg-muted text-foreground"
                                        >
                                            {e}
                                        </span>
                                    ))}
                                </div>
                            </SectionCard>
                        )}

                        <SectionCard title="Automation prompt">
                            <div className="flex flex-col gap-2">
                                <pre className="whitespace-pre-wrap text-xs bg-muted/60 dark:bg-muted/30 p-3 rounded-lg text-foreground">
                                    {workflow.automationPrompt}
                                </pre>
                                <div className="flex justify-end">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={copyAutomationPrompt}
                                    >
                                        <Copy className="size-3.5" />
                                        Copy
                                    </Button>
                                </div>
                            </div>
                        </SectionCard>

                        {workflow.riskWarnings.length > 0 && (
                            <SectionCard title="Risk warnings">
                                <ul className="text-sm text-foreground space-y-1">
                                    {workflow.riskWarnings.map((w, i) => (
                                        <li key={i} className="flex gap-2 items-start">
                                            <AlertTriangle className="size-4 mt-0.5 text-amber-500 shrink-0" />
                                            <span>{w}</span>
                                        </li>
                                    ))}
                                </ul>
                            </SectionCard>
                        )}
                    </>
                )}
            </div>
        </div>
    )
}
