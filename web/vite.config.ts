import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Bubble Agent OS',
        short_name: 'Bubble',
        description: 'Personal AI Agent powered by Bubble Theory',
        theme_color: '#7C3AED',
        background_color: '#0B0E17',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: '/bubble-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/bubble-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/.*\/api\/.*/,
            handler: 'NetworkFirst',
            options: { cacheName: 'api-cache', expiration: { maxEntries: 50 } },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
})
