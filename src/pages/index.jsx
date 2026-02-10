import Layout from "./Layout.jsx";

import Dashboard from "./Dashboard";

import ExecutionHistory from "./ExecutionHistory";

import Settings from "./Settings";

import WebhookLogs from "./WebhookLogs";

import AuditLog from "./AuditLog";

import { BrowserRouter as Router, Route, Routes, useLocation } from 'react-router-dom';

const PAGES = {

    Dashboard: Dashboard,

    ExecutionHistory: ExecutionHistory,

    Settings: Settings,

    WebhookLogs: WebhookLogs,

    AuditLog: AuditLog,

}

function _getCurrentPage(url) {
    if (url.endsWith('/')) {
        url = url.slice(0, -1);
    }
    let urlLastPart = url.split('/').pop();
    if (urlLastPart.includes('?')) {
        urlLastPart = urlLastPart.split('?')[0];
    }

    const pageName = Object.keys(PAGES).find(page => page.toLowerCase() === urlLastPart.toLowerCase());
    return pageName || Object.keys(PAGES)[0];
}

// Create a wrapper component that uses useLocation inside the Router context
function PagesContent() {
    const location = useLocation();
    const currentPage = _getCurrentPage(location.pathname);
    
    return (
        <Layout currentPageName={currentPage}>
            <Routes>            
                
                    <Route path="/" element={<Dashboard />} />
                
                
                <Route path="/Dashboard" element={<Dashboard />} />
                
                <Route path="/ExecutionHistory" element={<ExecutionHistory />} />
                
                <Route path="/Settings" element={<Settings />} />

                <Route path="/WebhookLogs" element={<WebhookLogs />} />

                <Route path="/AuditLog" element={<AuditLog />} />

            </Routes>
        </Layout>
    );
}

export default function Pages() {
    return (
        <Router>
            <PagesContent />
        </Router>
    );
}