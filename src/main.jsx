import 'temporal-polyfill/global';
import 'katex/dist/katex.min.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const boot = document.getElementById('daylight-boot');
    if (!boot) return;
    boot.dataset.done = '1';
    boot.setAttribute('aria-busy', 'false');
    window.setTimeout(() => boot.remove(), 400);
  });
});
