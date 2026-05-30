import React from 'react'
import ReactDOM from 'react-dom/client'
import { SidebarApp } from './SidebarApp'
import { initWebGpuGrounder } from './grounding/webgpuGrounder'
import './index.css'

initWebGpuGrounder()

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <SidebarApp />
    </React.StrictMode>
)

