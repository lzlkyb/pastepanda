import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import { ProductSurface } from './ProductSurface';
import { useAppStore, type AppMode, type HistoryItem } from '../../src/stores/appStore';
import { setAiAvailable } from '../../src/lib/transforms/aiTransforms';
import '../../src/styles/theme.css';
import '../../src/styles/globals.css';
import '../../src/styles/buttons.css';
import '../../src/styles/app.css';
import './surface.css';
import fixture from './fixture.json';

const query = new URLSearchParams(window.location.search);
const requestedMode = query.get('mode');
const mode: AppMode = requestedMode === 'tools' || requestedMode === 'knowledge' ? requestedMode : 'record';
setAiAvailable(false);
useAppStore.setState(state => ({
  appMode: mode, history: fixture as HistoryItem[], searchKeyword: query.get('keyword') || '', searchHistory: [],
  tags: [], selectedTagIds: [], noteHistoryIds: new Set<string>(), sidebarOpen: { record: false, knowledge: false },
  config: { ...state.config, theme: 'ocean', ai_enabled: false, lan_sync_enabled: false, hover_mode: 'off', source_icon_mode: 'emoji' },
}));
createRoot(document.getElementById('root')!).render(<MotionConfig reducedMotion="always"><ProductSurface /></MotionConfig>);
