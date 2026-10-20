import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {VitePWA} from 'vite-plugin-pwa';
export default defineConfig({
  plugins:[react(),VitePWA({registerType:'prompt',includeAssets:['icon.svg','apple-touch-icon.png'],manifest:{name:'清读',short_name:'清读',description:'搜书、收藏和离线阅读',lang:'zh-CN',start_url:'/',display:'standalone',background_color:'#f8f5ee',theme_color:'#f8f5ee',icons:[{src:'/icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]},workbox:{globPatterns:['**/*.{js,mjs,css,html,svg,png,woff2,bcmap,pfb,ttf,wasm}'],maximumFileSizeToCacheInBytes:6*1024*1024,navigateFallback:'/index.html',navigateFallbackDenylist:[/^\/api\//],runtimeCaching:[{urlPattern:({url})=>url.pathname.startsWith('/api/cover'),handler:'CacheFirst',options:{cacheName:'qingread-covers',expiration:{maxEntries:250,maxAgeSeconds:60*86400},cacheableResponse:{statuses:[200]}}},{urlPattern:({url})=>/^\/api\/(sources|categories|recommendations)/.test(url.pathname),handler:'NetworkFirst',options:{cacheName:'qingread-discovery',networkTimeoutSeconds:8,expiration:{maxEntries:30,maxAgeSeconds:7*86400},cacheableResponse:{statuses:[200]}}}]}})],
  server:{host:'127.0.0.1',port:5173,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:8787',changeOrigin:false}}},
  build:{target:['es2022','safari16'],outDir:'dist',sourcemap:false},
});
