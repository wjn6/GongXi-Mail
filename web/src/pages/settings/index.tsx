import React, { useCallback, useEffect, useState } from 'react';
import { Card, Form, Input, Button, message, Typography, Space, Tag, Alert, QRCode } from 'antd';
import { LockOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { authApi } from '../../api';
import { useAuthStore } from '../../stores/authStore';
import { getAdminRoleLabel } from '../../utils/auth';
import { requestData } from '../../utils/request';

const { Title, Text } = Typography;

interface TwoFactorStatus {
    enabled: boolean;
    pending: boolean;
    legacyEnv: boolean;
}

const SettingsPage: React.FC = () => {
    const [passwordLoading, setPasswordLoading] = useState(false);
    const [twoFactorLoading, setTwoFactorLoading] = useState(false);
    const [twoFactorStatusLoading, setTwoFactorStatusLoading] = useState(true);
    const [twoFactorStatus, setTwoFactorStatus] = useState<TwoFactorStatus>({
        enabled: false,
        pending: false,
        legacyEnv: false,
    });
    const [setupData, setSetupData] = useState<{ secret: string; otpauthUrl: string } | null>(null);
    const [enableOtp, setEnableOtp] = useState('');
    const [form] = Form.useForm();
    const [disable2FaForm] = Form.useForm();
    const { admin, token, setAuth } = useAuthStore();

    const syncStoreTwoFactor = useCallback((enabled: boolean) => {
        if (!token || !admin) {
            return;
        }
        setAuth(token, { ...admin, twoFactorEnabled: enabled });
    }, [admin, setAuth, token]);

    const loadTwoFactorStatus = async (silent: boolean = false) => {
        const result = await requestData<TwoFactorStatus>(
            () => authApi.getTwoFactorStatus(),
            '获取二次验证状态失败',
            { silent }
        );
        if (result) {
            setTwoFactorStatus(result);
            if (!result.pending) {
                setSetupData(null);
            }
            syncStoreTwoFactor(result.enabled);
        }
        setTwoFactorStatusLoading(false);
    };

    useEffect(() => {
        let cancelled = false;

        const init = async () => {
            const result = await requestData<TwoFactorStatus>(
                () => authApi.getTwoFactorStatus(),
                '获取二次验证状态失败',
                { silent: true }
            );
            if (!cancelled && result) {
                setTwoFactorStatus(result);
                if (!result.pending) {
                    setSetupData(null);
                }
                syncStoreTwoFactor(result.enabled);
            }
            if (!cancelled) {
                setTwoFactorStatusLoading(false);
            }
        };

        void init();
        return () => {
            cancelled = true;
        };
    }, [syncStoreTwoFactor]);

    const handleChangePassword = async (values: {
        oldPassword: string;
        newPassword: string;
        confirmPassword: string;
    }) => {
        if (values.newPassword !== values.confirmPassword) {
            message.error('两次输入的密码不一致');
            return;
        }

        setPasswordLoading(true);
        const result = await requestData<{ message?: string }>(
            () => authApi.changePassword(values.oldPassword, values.newPassword),
            '密码修改失败'
        );
        if (result) {
            message.success('密码修改成功');
            form.resetFields();
        }
        setPasswordLoading(false);
    };

    const handleSetup2Fa = async () => {
        setTwoFactorLoading(true);
        const result = await requestData<{ secret: string; otpauthUrl: string }>(
            () => authApi.setupTwoFactor(),
            '生成二次验证密钥失败'
        );
        if (result) {
            setSetupData(result);
            setTwoFactorStatus((prev) => ({ ...prev, pending: true, enabled: false, legacyEnv: false }));
            message.info('请在验证器中添加密钥后输入 6 位验证码完成启用');
        }
        setTwoFactorLoading(false);
    };

    const handleEnable2Fa = async () => {
        const otp = enableOtp.trim();
        if (!/^\d{6}$/.test(otp)) {
            message.error('请输入 6 位验证码');
            return;
        }

        setTwoFactorLoading(true);
        const result = await requestData<{ enabled: boolean }>(
            () => authApi.enableTwoFactor(otp),
            '启用二次验证失败'
        );
        if (result) {
            message.success('二次验证已启用');
            setEnableOtp('');
            setSetupData(null);
            await loadTwoFactorStatus();
        }
        setTwoFactorLoading(false);
    };

    const handleDisable2Fa = async (values: { password: string; otp: string }) => {
        setTwoFactorLoading(true);
        const result = await requestData<{ enabled: boolean }>(
            () => authApi.disableTwoFactor(values.password, values.otp),
            '禁用二次验证失败'
        );
        if (result) {
            message.success('二次验证已禁用');
            disable2FaForm.resetFields();
            await loadTwoFactorStatus();
        }
        setTwoFactorLoading(false);
    };

    return (
        <div>
            <Title level={4}>设置</Title>

            <Space direction="vertical" size="large" style={{ width: '100%' }}>
                <Card title="个人信息">
                    <div style={{ display: 'grid', gap: 16 }}>
                        <div>
                            <Text type="secondary">用户名</Text>
                            <div style={{ fontSize: 16 }}>{admin?.username}</div>
                        </div>
                        <div>
                            <Text type="secondary">角色</Text>
                            <div style={{ fontSize: 16 }}>
                                {getAdminRoleLabel(admin?.role)}
                            </div>
                        </div>
                    </div>
                </Card>

                <Card title="修改密码">
                    <Form
                        form={form}
                        layout="vertical"
                        onFinish={handleChangePassword}
                        style={{ maxWidth: 400 }}
                    >
                        <Form.Item
                            name="oldPassword"
                            label="当前密码"
                            rules={[{ required: true, message: '请输入当前密码' }]}
                        >
                            <Input.Password prefix={<LockOutlined />} placeholder="当前密码" />
                        </Form.Item>

                        <Form.Item
                            name="newPassword"
                            label="新密码"
                            rules={[
                                { required: true, message: '请输入新密码' },
                                { min: 6, message: '密码至少 6 个字符' },
                            ]}
                        >
                            <Input.Password prefix={<LockOutlined />} placeholder="新密码" />
                        </Form.Item>

                        <Form.Item
                            name="confirmPassword"
                            label="确认新密码"
                            rules={[
                                { required: true, message: '请确认新密码' },
                                ({ getFieldValue }) => ({
                                    validator(_, value) {
                                        if (!value || getFieldValue('newPassword') === value) {
                                            return Promise.resolve();
                                        }
                                        return Promise.reject(new Error('两次输入的密码不一致'));
                                    },
                                }),
                            ]}
                        >
                            <Input.Password prefix={<LockOutlined />} placeholder="确认新密码" />
                        </Form.Item>

                        <Form.Item>
                            <Button type="primary" htmlType="submit" loading={passwordLoading}>
                                修改密码
                            </Button>
                        </Form.Item>
                    </Form>
                </Card>

                <Card title="二次验证（2FA）">
                    {twoFactorStatusLoading ? (
                        <Text type="secondary">加载中...</Text>
                    ) : (
                        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                            <div>
                                <Text type="secondary">当前状态：</Text>{' '}
                                {twoFactorStatus.enabled ? <Tag color="success">已启用</Tag> : <Tag>未启用</Tag>}
                                {twoFactorStatus.pending && !twoFactorStatus.enabled ? <Tag color="processing">待验证</Tag> : null}
                            </div>

                            {twoFactorStatus.legacyEnv ? (
                                <Alert
                                    type="warning"
                                    showIcon
                                    message="当前账号使用环境变量 2FA（ADMIN_2FA_SECRET），暂不支持在界面中直接管理。"
                                />
                            ) : null}

                            {!twoFactorStatus.enabled ? (
                                <Button
                                    type="primary"
                                    icon={<SafetyCertificateOutlined />}
                                    onClick={handleSetup2Fa}
                                    loading={twoFactorLoading}
                                >
                                    生成绑定密钥
                                </Button>
                            ) : null}

                            {setupData ? (
                                <Card size="small" title="绑定信息">
                                    <Space direction="vertical" style={{ width: '100%' }}>
                                        <div style={{ textAlign: 'center' }}>
                                            <Text type="secondary">扫码绑定（推荐）</Text>
                                            <div style={{ marginTop: 8 }}>
                                                <QRCode value={setupData.otpauthUrl} size={180} />
                                            </div>
                                        </div>
                                        <div>
                                            <Text type="secondary">手动密钥（可复制）</Text>
                                            <div><Text copyable>{setupData.secret}</Text></div>
                                        </div>
                                        <div>
                                            <Text type="secondary">otpauth 链接（可复制）</Text>
                                            <div><Text copyable>{setupData.otpauthUrl}</Text></div>
                                        </div>
                                        <Input
                                            value={enableOtp}
                                            onChange={(e) => setEnableOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                            placeholder="输入验证器中的 6 位验证码"
                                            maxLength={6}
                                            prefix={<SafetyCertificateOutlined />}
                                        />
                                        <Button type="primary" onClick={handleEnable2Fa} loading={twoFactorLoading}>
                                            启用二次验证
                                        </Button>
                                    </Space>
                                </Card>
                            ) : null}

                            {twoFactorStatus.enabled ? (
                                <Card size="small" title="禁用二次验证">
                                    <Form form={disable2FaForm} layout="vertical" onFinish={handleDisable2Fa}>
                                        <Form.Item
                                            name="password"
                                            label="当前密码"
                                            rules={[{ required: true, message: '请输入当前密码' }]}
                                        >
                                            <Input.Password prefix={<LockOutlined />} placeholder="当前密码" />
                                        </Form.Item>
                                        <Form.Item
                                            name="otp"
                                            label="验证码"
                                            rules={[
                                                { required: true, message: '请输入验证码' },
                                                { pattern: /^\d{6}$/, message: '请输入 6 位验证码' },
                                            ]}
                                        >
                                            <Input
                                                maxLength={6}
                                                prefix={<SafetyCertificateOutlined />}
                                                placeholder="6 位验证码"
                                            />
                                        </Form.Item>
                                        <Form.Item style={{ marginBottom: 0 }}>
                                            <Button danger htmlType="submit" loading={twoFactorLoading}>
                                                禁用二次验证
                                            </Button>
                                        </Form.Item>
                                    </Form>
                                </Card>
                            ) : null}
                        </Space>
                    )}
                </Card>

                <Card title="API 使用说明">
                    <div style={{ marginBottom: 16 }}>
                        <Text strong>外部 API 调用方式</Text>
                    </div>

                    <div style={{ background: '#f5f5f5', padding: 16, borderRadius: 8, marginBottom: 16 }}>
                        <Text code style={{ display: 'block', marginBottom: 8 }}>
                            # 通过 Header 传递 API Key
                        </Text>
                        <Text code style={{ display: 'block', wordBreak: 'break-all' }}>
                            curl -H "X-API-Key: your_api_key" https://your-domain.com/api/mail_all
                        </Text>
                    </div>

                    <div style={{ background: '#f5f5f5', padding: 16, borderRadius: 8 }}>
                        <Text code style={{ display: 'block', marginBottom: 8 }}>
                            # 通过 Query 参数传递 API Key
                        </Text>
                        <Text code style={{ display: 'block', wordBreak: 'break-all' }}>
                            curl "https://your-domain.com/api/mail_all?api_key=your_api_key&email=xxx@outlook.com"
                        </Text>
                    </div>
                </Card>
            </Space>
        </div>
    );
};

export default SettingsPage;
