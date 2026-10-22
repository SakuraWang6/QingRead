import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {VitePWA} from 'vite-plugin-pwa';

// A shared host must give each PWA its own assets, manifest and worker scope.
const base = process.env.QINGREAD_WEB_BASE || '/';
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error('QINGREAD_WEB_BASE 必须是以 / 开头和结尾的路径');
const navigationScope = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

export default defineConfig({
  base,
  plugins:[react(),VitePWA({scope:base,registerType:'prompt',includeAssets:['icon.svg','apple-touch-icon.png'],manifest:{id:base,name:'清读',short_name:'清读',description:'搜书、收藏和离线阅读',lang:'zh-CN',start_url:base,scope:base,display:'standalone',background_color:'#f8f5ee',theme_color:'#f8f5ee',icons:[{src:base+'icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]},workbox:{importScripts:[base+'push-worker.js'],cacheId:'qingread',globPatterns:['**/*.{js,mjs,css,html,svg,png,woff2,bcmap,pfb,ttf,wasm}'],maximumFileSizeToCacheInBytes:6*1024*1024,navigateFallback:base+'index.html',navigateFallbackAllowlist:[navigationScope],navigateFallbackDenylist:[/^\/api\//],runtimeCaching:[{urlPattern:({url})=>url.pathname.startsWith('/api/cover'),handler:'CacheFirst',options:{cacheName:'qingread-covers',expiration:{maxEntries:250,maxAgeSeconds:60*86400},cacheableResponse:{statuses:[200]}}},{urlPattern:({url})=>/^\/api\/(sources|categories|recommendations)/.test(url.pathname),handler:'NetworkFirst',options:{cacheName:'qingread-discovery',networkTimeoutSeconds:8,expiration:{maxEntries:30,maxAgeSeconds:7*86400},cacheableResponse:{statuses:[200]}}}]}})],
  server:{host:'127.0.0.1',port:5173,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:8787',changeOrigin:false}}},
  build:{target:['es2022','safari16'],outDir:'dist',sourcemap:false},
});
