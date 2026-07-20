import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth'
import AdminDashboardPage from './pages/AdminDashboardPage'
import EncounterWorkspacePage from './pages/EncounterWorkspacePage'
import LoginPage from './pages/LoginPage'
import NewEncounterPage from './pages/NewEncounterPage'
import PatientDetailPage from './pages/PatientDetailPage'
import PatientsPage from './pages/PatientsPage'
import './App.css'

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="app narrow">
        <p className="empty">Loading…</p>
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return children
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="app narrow">
        <p className="empty">Loading…</p>
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'admin') return <Navigate to="/patients" replace />
  return children
}

function ProviderOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="app narrow">
        <p className="empty">Loading…</p>
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  if (user.role === 'admin') return <Navigate to="/admin" replace />
  return children
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/admin"
        element={
          <AdminOnly>
            <AdminDashboardPage />
          </AdminOnly>
        }
      />
      <Route
        path="/patients"
        element={
          <ProviderOnly>
            <PatientsPage />
          </ProviderOnly>
        }
      />
      <Route
        path="/patients/:patientId"
        element={
          <ProviderOnly>
            <PatientDetailPage />
          </ProviderOnly>
        }
      />
      <Route
        path="/encounters/new"
        element={
          <ProviderOnly>
            <NewEncounterPage />
          </ProviderOnly>
        }
      />
      <Route
        path="/encounters/:encounterId"
        element={
          <Protected>
            <EncounterWorkspacePage />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  )
}
