import React, { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import { AdminShell } from '@/components/admin-shell';
import { AppShell } from '@/components/app-shell';
import { BootScreen } from '@/components/boot-screen';
import { ErrorBoundary } from '@/components/error-boundary';
import { EventDialog } from '@/components/event-dialog';
import { OnboardingHost } from '@/components/onboarding';
import { AttachmentViewerProvider } from '@/components/attachment-viewer-context';
import { ThemeProvider } from '@/components/theme-provider';
import { WorkspaceProvider, useWorkspace } from '@/context/workspace';
import { WorkbenchesProvider } from '@/context/workbenches';
import { getAuthToken } from '@/lib/auth-api';
import { AuthProvider, useAuthUser } from '@/lib/auth-session';
import WorkbenchesPage from '@/pages/workbenches-page';
import OverviewPage from '@/pages/overview';
import CalendarPage from '@/pages/calendar-page';
import MailPage from '@/pages/mail-page';
import InvoicesPage from '@/pages/invoices-page';
import CampusPage from '@/pages/campus-page';
import MailDeskPage from '@/pages/mail-desk-page';
import RecruitmentPage from '@/pages/recruitment-page';
import SettingsPage from '@/pages/settings-page';
import TracesPage from '@/pages/traces-page';
import JobsPage from '@/pages/jobs-page';
import TodosPage from '@/pages/todos-page';
import AccountPage from '@/pages/account-page';
import LandingPage from '@/pages/landing-page';
import LoginPage from '@/pages/login-page';
import RegisterPage from '@/pages/register-page';
import ForgotPasswordPage from '@/pages/forgot-password-page';
import ResetPasswordPage from '@/pages/reset-password-page';
import LegalPage from '@/pages/legal-page';
import AdminPage from '@/pages/admin-page';
import AdminLoginPage from '@/pages/admin-login-page';
import { AppErrorPage, NotFoundPage, ServiceUnavailablePage } from '@/pages/error-page';

function BootGate({ children }) {
  const { state, loadError, reload } = useWorkspace();
  if (loadError && !state) {
    return (
      <ServiceUnavailablePage
        detail={loadError}
        onRetry={() => reload().catch(() => {})}
      />
    );
  }
  if (!state) {
    return <BootScreen label="正在加载工作区…" />;
  }
  return (
    <div className="animate-in fade-in duration-300 fill-mode-both">
      {children}
    </div>
  );
}

function RequireAuth({ children }) {
  const location = useLocation();
  const { user, loading, refresh } = useAuthUser();
  const [ready, setReady] = useState(() => Boolean(user) || !getAuthToken());

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!getAuthToken()) {
        if (!cancelled) setReady(true);
        return;
      }
      if (user) {
        if (!cancelled) setReady(true);
        return;
      }
      await refresh();
      if (!cancelled) setReady(true);
    }
    run();
    return () => { cancelled = true; };
  }, [refresh, user]);

  if (loading || !ready) {
    return <BootScreen label="正在验证登录…" />;
  }
  if (!getAuthToken() || !user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return children;
}

/** 管理端强制登录 + 管理员身份，与用户端门禁分离。 */
function RequireAdmin({ children }) {
  const location = useLocation();
  const { user, loading, isAdmin, refresh } = useAuthUser();
  const [ready, setReady] = useState(() => Boolean(user) || !getAuthToken());

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!getAuthToken()) {
        if (!cancelled) setReady(true);
        return;
      }
      if (user) {
        if (!cancelled) setReady(true);
        return;
      }
      await refresh();
      if (!cancelled) setReady(true);
    }
    run();
    return () => { cancelled = true; };
  }, [refresh, user]);

  if (loading || !ready) {
    return <BootScreen label="正在进入管理端…" />;
  }
  if (!getAuthToken() || !user) {
    return <Navigate to="/admin/login" replace state={{ from: location }} />;
  }
  if (!isAdmin) {
    return <Navigate to="/admin/login" replace state={{ from: location, denied: true }} />;
  }
  return children;
}

function AppWorkspace() {
  return (
    <RequireAuth>
      <WorkspaceProvider>
        <BootGate>
          <WorkbenchesProvider>
            <Outlet />
            <EventDialog />
            <OnboardingHost />
          </WorkbenchesProvider>
        </BootGate>
      </WorkspaceProvider>
    </RequireAuth>
  );
}

function AdminPortal() {
  return (
    <RequireAdmin>
      <AdminShell />
    </RequireAdmin>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AttachmentViewerProvider>
        <BrowserRouter>
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/legal/:doc" element={<LegalPage />} />
              <Route path="/terms" element={<Navigate to="/legal/terms" replace />} />
              <Route path="/privacy" element={<Navigate to="/legal/privacy" replace />} />
              <Route path="/policies" element={<Navigate to="/legal/policies" replace />} />
              <Route path="/502" element={<ServiceUnavailablePage />} />
              <Route path="/500" element={<AppErrorPage />} />

              {/* 用户工作区 */}
              <Route path="/app" element={<AppWorkspace />}>
                <Route element={<AppShell />}>
                  <Route index element={<OverviewPage />} />
                  <Route path="workbenches" element={<WorkbenchesPage />} />
                  <Route path="workbenches/:id" element={<WorkbenchesPage />} />
                  <Route path="calendar" element={<CalendarPage />} />
                  <Route path="todos" element={<TodosPage />} />
                  <Route path="mail" element={<MailPage />} />
                  <Route path="invoices" element={<InvoicesPage />} />
                  <Route path="recruitment" element={<RecruitmentPage />} />
                  <Route path="campus" element={<CampusPage />} />
                  <Route path="mail-desk" element={<MailDeskPage />} />
                  <Route path="traces" element={<TracesPage />} />
                  <Route path="jobs" element={<JobsPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="account" element={<AccountPage />} />
                  <Route path="*" element={<NotFoundPage embedded />} />
                </Route>
              </Route>

              {/* 独立管理端：先登录，再进入控制台 */}
              <Route path="/admin/login" element={<AdminLoginPage />} />
              <Route path="/admin" element={<AdminPortal />}>
                <Route index element={<AdminPage />} />
                <Route path="monitor/jobs" element={<AdminPage />} />
                <Route path="monitor/traces" element={<AdminPage />} />
                <Route path="users" element={<AdminPage />} />
                <Route path="users/:id" element={<AdminPage />} />
                <Route path="mailboxes" element={<AdminPage />} />
                <Route path="storage" element={<AdminPage />} />
                <Route path="storage/oss" element={<AdminPage />} />
                <Route path="mail" element={<AdminPage />} />
                <Route path="workspace" element={<AdminPage />} />
                <Route path="onboarding" element={<AdminPage />} />
                <Route path="auth" element={<AdminPage />} />
                <Route path="*" element={<NotFoundPage embedded />} />
              </Route>

              <Route path="/app/admin" element={<Navigate to="/admin" replace />} />
              <Route path="/calendar" element={<Navigate to="/app/calendar" replace />} />
              <Route path="/mail" element={<Navigate to="/app/mail" replace />} />
              <Route path="/traces" element={<Navigate to="/app/traces" replace />} />
              <Route path="/settings" element={<Navigate to="/app/settings" replace />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
            <Toaster richColors position="bottom-center" />
          </ErrorBoundary>
        </BrowserRouter>
        </AttachmentViewerProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
