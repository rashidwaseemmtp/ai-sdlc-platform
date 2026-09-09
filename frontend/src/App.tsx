import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useApi } from './api';
import { Projects } from './pages/Projects';
import { Project } from './pages/Project';
import { Approvals } from './pages/Approvals';
import { Approval } from './pages/Approval';
import { Runs } from './pages/Runs';
import { Agents } from './pages/Agents';
import { Mcp } from './pages/Mcp';
import { Settings } from './pages/Settings';

export function App() {
  // Polled so the sidebar count nags while something is waiting on a person.
  const { data: pending } = useApi<unknown[]>('/approvals?status=PENDING', 10_000);
  const waiting = pending?.length ?? 0;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          AI SDLC Platform
          <small>agents · gates · one backend</small>
        </div>
        <nav className="nav">
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/approvals">Approvals{waiting > 0 ? ` (${waiting})` : ''}</NavLink>
          <NavLink to="/runs">Agent runs</NavLink>
          <NavLink to="/agents">Agents</NavLink>
          <NavLink to="/mcp">MCP &amp; tools</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:key" element={<Project />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/approvals/:id" element={<Approval />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<Runs />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/mcp" element={<Mcp />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<div className="empty">No such page.</div>} />
        </Routes>
      </main>
    </div>
  );
}
