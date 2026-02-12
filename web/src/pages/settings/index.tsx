import React, { useState } from 'react';
import { Card, Form, Input, Button, message, Typography, Space } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { authApi } from '../../api';
import { useAuthStore } from '../../stores/authStore';
import { getAdminRoleLabel } from '../../utils/auth';
import { requestData } from '../../utils/request';

const { Title, Text } = Typography;

const SettingsPage: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [form] = Form.useForm();
    const { admin } = useAuthStore();

    const handleChangePassword = async (values: {
        oldPassword: string;
        newPassword: string;
        confirmPassword: string;
    }) => {
        if (values.newPassword !== values.confirmPassword) {
            message.error('两次输入的密码不一致');
            return;
        }

        setLoading(true);
        const result = await requestData<{ message?: string }>(
            () => authApi.changePassword(values.oldPassword, values.newPassword),
            '密码修改失败'
        );
        if (result) {
            message.success('密码修改成功');
            form.resetFields();
        }
        setLoading(false);
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
                            <Button type="primary" htmlType="submit" loading={loading}>
                                修改密码
                            </Button>
                        </Form.Item>
                    </Form>
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
