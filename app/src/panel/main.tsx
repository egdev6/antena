import { createRoot } from 'react-dom/client';
import { App } from './App';
import '../styles/panel.css';
import '../styles/acerca.css';
import 'driver.js/dist/driver.css';
import '../styles/tour.css';
createRoot(document.getElementById('root')!).render(<App />);
