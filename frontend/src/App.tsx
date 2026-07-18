import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth'
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

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/patients"
        element={
          <Protected>
            <PatientsPage />
          </Protected>
        }
      />
      <Route
        path="/patients/:patientId"
        element={
          <Protected>
            <PatientDetailPage />
          </Protected>
        }
      />
      <Route
        path="/encounters/new"
        element={
          <Protected>
            <NewEncounterPage />
          </Protected>
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
