import React from 'react';
import { createRoot } from 'react-dom/client';
import BrowserApp from './BrowserApp';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '../styles.css';
createRoot(document.getElementById('root')).render(<BrowserApp />);
