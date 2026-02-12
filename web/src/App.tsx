import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider, App as AntApp, Spin } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useAuthStore } from './stores/authStore';
import { isSuperAdmin } from './utils/auth';

// Pages (lazy loaded)
const LoginPage = lazy(() => import('./pages/login'));
const MainLayout = lazy(() => import('./layouts/MainLayout'));
const DashboardPage = lazy(() => import('./pages/dashboard'));
const EmailsPage = lazy(() => import('./pages/emails'));
const ApiKeysPage = lazy(() => import('./pages/api-keys'));
const ApiDocsPage = lazy(() => import('./pages/api-docs'));
const OperationLogsPage = lazy(() => import('./pages/operation-logs'));
const AdminsPage = lazy(() => import('./pages/admins'));
const SettingsPage = lazy(() => import('./pages/settings'));

const PageFallback: React.FC = () => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 240 }}>
    <Spin />
  </div>
);

// 路由守卫组件
const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuthStore();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};

// 超级管理员路由守卫
const SuperAdminRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, admin } = useAuthStore();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (!isSuperAdmin(admin?.role)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
};

const App: React.FC = () => {
  const withSuspense = (element: React.ReactElement) => (
    <Suspense fallback={<PageFallback />}>
      {element}
    </Suspense>
  );

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        cssVar: {},
        token: {
          colorPrimary: '#1890ff',
          borderRadius: 6,
        },
      }}
    >
      <AntApp>
        <BrowserRouter>
          <Routes>
            {/* 登录页 */}
            <Route path="/login" element={withSuspense(<LoginPage />)} />

            {/* 需要认证的页面 */}
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  {withSuspense(<MainLayout />)}
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={withSuspense(<DashboardPage />)} />
              <Route path="emails" element={withSuspense(<EmailsPage />)} />
              <Route path="api-keys" element={withSuspense(<ApiKeysPage />)} />
              <Route path="api-docs" element={withSuspense(<ApiDocsPage />)} />
              <Route path="operation-logs" element={withSuspense(<OperationLogsPage />)} />
              <Route
                path="admins"
                element={
                  <SuperAdminRoute>
                    {withSuspense(<AdminsPage />)}
                  </SuperAdminRoute>
                }
              />
              <Route path="settings" element={withSuspense(<SettingsPage />)} />
            </Route>

            {/* 404 重定向 */}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
};

export default App;
