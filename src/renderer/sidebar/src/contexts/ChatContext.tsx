import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { createLogger } from '@common/lib/logger'

const log = createLogger('sidebar')

interface Message {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    isStreaming?: boolean
}

interface ChatContextType {
    messages: Message[]
    isLoading: boolean

    // Chat actions
    sendMessage: (content: string) => Promise<void>
    clearChat: () => void

    // Page content access
    getPageText: () => Promise<string | null>
    getCurrentUrl: () => Promise<string | null>
}

const ChatContext = createContext<ChatContextType | null>(null)

const extractText = (content: any): string => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
        .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
        .map((p: any) => p.text)
        .join('')
}

/** True when an assistant message is a mid-task step with tool calls — not the final answer. */
const isIntermediateStep = (msg: any): boolean => {
    if (msg.role !== 'assistant') return false
    if (!Array.isArray(msg.content)) return false
    return msg.content.some((p: any) => p?.type === 'tool-call')
}

const toDisplayMessages = (raw: any[]): Message[] => {
    const out: Message[] = []

    // Find the last assistant message index so we always show it even if it has
    // tool calls (edge case: agent finishes without a plain-text final answer).
    let lastAssistantIdx = -1
    raw.forEach((msg, i) => { if (msg.role === 'assistant') lastAssistantIdx = i })

    raw.forEach((msg, index) => {
        if (msg.role !== 'user' && msg.role !== 'assistant') return
        // Skip intermediate steps (assistant messages mid-task that called tools),
        // but always keep the last assistant message so something is shown.
        if (isIntermediateStep(msg) && index !== lastAssistantIdx) return
        const content = extractText(msg.content).trim()
        if (!content) return
        out.push({
            id: `msg-${index}`,
            role: msg.role,
            content,
            timestamp: Date.now(),
            isStreaming: false,
        })
    })
    return out
}

export const useChat = () => {
    const context = useContext(ChatContext)
    if (!context) {
        throw new Error('useChat must be used within a ChatProvider')
    }
    return context
}

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [messages, setMessages] = useState<Message[]>([])
    const [isLoading, setIsLoading] = useState(false)

    // Load initial messages from main process
    useEffect(() => {
        const loadMessages = async () => {
            try {
                const storedMessages = await window.sidebarAPI.getMessages()
                if (storedMessages && storedMessages.length > 0) {
                    setMessages(toDisplayMessages(storedMessages))
                }
            } catch (error) {
                log.error({ err: error }, 'Failed to load messages')
            }
        }
        loadMessages()
    }, [])

    const sendMessage = useCallback(async (content: string) => {
        setIsLoading(true)

        try {
            const messageId = Date.now().toString()

            await window.sidebarAPI.sendChatMessage({
                message: content,
                messageId: messageId
            })
        } catch (error) {
            log.error({ err: error }, 'Failed to send message')
            setIsLoading(false)
        }
    }, [])

    const clearChat = useCallback(async () => {
        try {
            await window.sidebarAPI.clearChat()
            setMessages([])
        } catch (error) {
            log.error({ err: error }, 'Failed to clear chat')
        }
    }, [])

    const getPageText = useCallback(async () => {
        try {
            return await window.sidebarAPI.getPageText()
        } catch (error) {
            log.error({ err: error }, 'Failed to get page text')
            return null
        }
    }, [])

    const getCurrentUrl = useCallback(async () => {
        try {
            return await window.sidebarAPI.getCurrentUrl()
        } catch (error) {
            log.error({ err: error }, 'Failed to get current URL')
            return null
        }
    }, [])

    // Set up message listeners
    useEffect(() => {
        // Listen for streaming response updates
        const handleChatResponse = (data: { messageId: string; content: string; isComplete: boolean }) => {
            if (data.isComplete) {
                setIsLoading(false)
            }
        }

        // Listen for message updates from main process
        const handleMessagesUpdated = (updatedMessages: any[]) => {
            setMessages(toDisplayMessages(updatedMessages))
        }

        window.sidebarAPI.onChatResponse(handleChatResponse)
        window.sidebarAPI.onMessagesUpdated(handleMessagesUpdated)

        return () => {
            window.sidebarAPI.removeChatResponseListener()
            window.sidebarAPI.removeMessagesUpdatedListener()
        }
    }, [])

    const value: ChatContextType = {
        messages,
        isLoading,
        sendMessage,
        clearChat,
        getPageText,
        getCurrentUrl
    }

    return (
        <ChatContext.Provider value={value}>
            {children}
        </ChatContext.Provider>
    )
}

