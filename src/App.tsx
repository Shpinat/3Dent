import React from 'react';
import { AppProvider, useAppContext } from './context/AppContext';
import { StudyManager } from './pages/StudyManager';
import { Viewer } from './pages/Viewer';

const AppContent: React.FC = () => {
  const { activeStudyId } = useAppContext();

  return (
    <div className="dark h-full w-full bg-background text-foreground">
      {activeStudyId ? <Viewer /> : <StudyManager />}
    </div>
  );
};

function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}

export default App;
