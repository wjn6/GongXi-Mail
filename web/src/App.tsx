import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useAuthStore } from './stores/authStore';
import { isSuperAdmin } from './utils/auth';

// Layouts
import MainLayout from './layouts/MainLayout';

// Pages
import LoginPage from './pages/login';
import DashboardPage from './pages/dashboard';
import EmailsPage from './pages/emails';
import ApiKeysPage from './pages/api-keys';
import ApiDocsPage from './pages/api-docs';
import OperationLogsPage from './pages/operation-logs';
import AdminsPage from './pages/admins';
import SettingsPage from './pages/settings';

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
            <Route path="/login" element={<LoginPage />} />

            {/* 需要认证的页面 */}
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <MainLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="emails" element={<EmailsPage />} />
              <Route path="api-keys" element={<ApiKeysPage />} />
              <Route path="api-docs" element={<ApiDocsPage />} />
              <Route path="operation-logs" element={<OperationLogsPage />} />
              <Route
                path="admins"
                element={
                  <SuperAdminRoute>
                    <AdminsPage />
                  </SuperAdminRoute>
                }
              />
              <Route path="settings" element={<SettingsPage />} />
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
