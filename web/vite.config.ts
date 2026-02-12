import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/admin': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return
          }
          if (id.includes('react') || id.includes('scheduler')) {
            return 'react-vendor'
          }
          if (id.includes('antd') || id.includes('@ant-design')) {
            return 'antd-vendor'
          }
          if (id.includes('react-router-dom') || id.includes('react-router')) {
            return 'router-vendor'
          }
          if (id.includes('axios') || id.includes('zustand') || id.includes('dayjs')) {
            return 'utils-vendor'
          }
        },
      },
    },
  },
})
