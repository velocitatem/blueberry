import React, { useEffect, useState } from 'react'
import { MessageSquare, Workflow } from 'lucide-react'
import { ChatProvider } from './contexts/ChatContext'
import { Chat } from './components/Chat'
import { Workflows } from './components/Workflows'
import { useDarkMode } from '@common/hooks/useDarkMode'
import { cn } from '@common/lib/utils'

type SidebarView = 'chat' | 'workflows'

const SidebarContent: React.FC = () => {
    const { isDarkMode } = useDarkMode()
    const [view, setView] = useState<SidebarView>('chat')

    useEffect(() => {
        if (isDarkMode) {
            document.documentElement.classList.add('dark')
        } else {
            document.documentElement.classList.remove('dark')
        }
    }, [isDarkMode])

    return (
        <div className="h-screen flex flex-col bg-background border-l border-border">
            <div className="flex items-center gap-1 px-2 pt-2 border-b border-border">
                <TabButton
                    label="Chat"
                    icon={<MessageSquare className="size-4" />}
                    active={view === 'chat'}
                    onClick={() => setView('chat')}
                />
                <TabButton
                    label="Workflows"
                    icon={<Workflow className="size-4" />}
                    active={view === 'workflows'}
                    onClick={() => setView('workflows')}
                />
            </div>
            <div className="flex-1 min-h-0">
                {view === 'chat' ? <Chat /> : <Workflows onStarted={() => setView('chat')} />}
            </div>
        </div>
    )
}

const TabButton: React.FC<{
    label: string
    icon: React.ReactNode
    active: boolean
    onClick: () => void
}> = ({ label, icon, active, onClick }) => (
    <button
        onClick={onClick}
        className={cn(
            'flex items-center gap-1.5 px-3 py-2 text-sm rounded-t-md border-b-2 -mb-px transition-colors',
            active
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
        )}
    >
        {icon}
        {label}
    </button>
)

export const SidebarApp: React.FC = () => {
    return (
        <ChatProvider>
            <SidebarContent />
        </ChatProvider>
    )
}
