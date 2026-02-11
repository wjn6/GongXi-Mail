import React, { useState } from 'react';
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import {
    Layout,
    Menu,
    Avatar,
    Dropdown,
    theme,
    Typography,
    Space,
    Breadcrumb,
} from 'antd';
import type { MenuProps } from 'antd';
import {
    DashboardOutlined,
    UserOutlined,
    KeyOutlined,
    MailOutlined,
    SettingOutlined,
    LogoutOutlined,
    MenuFoldOutlined,
    MenuUnfoldOutlined,
    FileTextOutlined,
    HistoryOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../stores/authStore';
import { authApi } from '../api';
import { isSuperAdmin } from '../utils/auth';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

const menuConfig = [
    { key: '/dashboard', icon: <DashboardOutlined />, label: '数据概览', title: '数据概览' },
    { key: '/emails', icon: <MailOutlined />, label: '邮箱管理', title: '邮箱管理' },
    { key: '/api-keys', icon: <KeyOutlined />, label: 'API Key', title: 'API Key 管理' },
    { key: '/api-docs', icon: <FileTextOutlined />, label: 'API 文档', title: 'API 文档' },
    { key: '/operation-logs', icon: <HistoryOutlined />, label: '操作日志', title: '操作日志' },
    { key: '/admins', icon: <UserOutlined />, label: '管理员', title: '管理员管理', superAdmin: true },
    { key: '/settings', icon: <SettingOutlined />, label: '系统设置', title: '系统设置' },
];

const MainLayout: React.FC = () => {
    const [collapsed, setCollapsed] = useState(false);
    const navigate = useNavigate();
    const location = useLocation();
    const { admin, clearAuth } = useAuthStore();
    const { token } = theme.useToken();

    const hasSuperAdminPermission = isSuperAdmin(admin?.role);
    const menuItems: MenuProps['items'] = menuConfig
        .filter(item => !item.superAdmin || hasSuperAdminPermission)
        .map(item => ({
            key: item.key,
            icon: item.icon,
            label: <Link to={item.key}>{item.label}</Link>,
        }));

    const handleLogout = async () => {
        try {
            await authApi.logout();
        } catch {
            // ignore
        }
        clearAuth();
        navigate('/login');
    };

    const userMenuItems: MenuProps['items'] = [
        {
            key: 'profile',
            icon: <UserOutlined />,
            label: '个人设置',
            onClick: () => navigate('/settings'),
        },
        { type: 'divider' },
        {
            key: 'logout',
            icon: <LogoutOutlined />,
            label: '退出登录',
            danger: true,
            onClick: handleLogout,
        },
    ];

    const currentMenu = menuConfig.find(item => location.pathname.startsWith(item.key));
    const pageTitle = currentMenu?.title || '管理后台';

    const selectedKeys = menuConfig
        .filter(item => location.pathname.startsWith(item.key))
        .map(item => item.key);

    return (
        <Layout style={{ minHeight: '100vh' }}>
            <Sider
                trigger={null}
                collapsible
                collapsed={collapsed}
                theme="light"
                width={208}
                style={{
                    overflow: 'auto',
                    height: '100vh',
                    position: 'fixed',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    borderRight: '1px solid #f0f0f0',
                }}
            >
                <div
                    style={{
                        height: 64,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderBottom: '1px solid #f0f0f0',
                    }}
                >
                    <Space>
                        <div
                            style={{
                                width: 32,
                                height: 32,
                                borderRadius: 8,
                                background: '#1890ff',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: '#fff',
                                fontWeight: 600,
                            }}
                        >
                            GX
                        </div>
                        {!collapsed && (
                            <Text strong style={{ fontSize: 16 }}>廾匸邮箱</Text>
                        )}
                    </Space>
                </div>
                <Menu
                    theme="light"
                    mode="inline"
                    selectedKeys={selectedKeys}
                    items={menuItems}
                    style={{ borderRight: 0, marginTop: 8 }}
                />
            </Sider>

            <Layout style={{ marginLeft: collapsed ? 80 : 208, transition: 'all 0.2s' }}>
                <Header
                    style={{
                        padding: '0 24px',
                        background: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        borderBottom: '1px solid #f0f0f0',
                        height: 56,
                        lineHeight: '56px',
                    }}
                >
                    <Space>
                        <span
                            onClick={() => setCollapsed(!collapsed)}
                            style={{ fontSize: 16, cursor: 'pointer', color: '#595959' }}
                        >
                            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                        </span>
                        <Breadcrumb
                            items={[
                                { title: '首页' },
                                { title: pageTitle },
                            ]}
                            style={{ marginLeft: 16 }}
                        />
                    </Space>

                    <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
                        <Space style={{ cursor: 'pointer' }}>
                            <Avatar size="small" style={{ backgroundColor: '#1890ff' }}>
                                {admin?.username?.charAt(0).toUpperCase()}
                            </Avatar>
                            <Text>{admin?.username}</Text>
                        </Space>
                    </Dropdown>
                </Header>

                <Content
                    style={{
                        margin: 24,
                        padding: 24,
                        background: '#fff',
                        borderRadius: token.borderRadiusLG,
                        minHeight: 'calc(100vh - 56px - 48px)',
                    }}
                >
                    <Outlet />
                </Content>
            </Layout>
        </Layout>
    );
};

export default MainLayout;
