import type { CapacitorConfig } from '@capacitor/cli';
const config:CapacitorConfig={
  appId:'app.qingread.android',appName:'清读',webDir:'dist',
  server:{hostname:'localhost',androidScheme:'https',cleartext:false,errorPath:'webview-error.html'},
  android:{backgroundColor:'#f8f5ee',allowMixedContent:false,minWebViewVersion:125},
  plugins:{SystemBars:{insetsHandling:'native',initialViewportFitValueHint:'cover',style:'LIGHT'}},
};
export default config;
