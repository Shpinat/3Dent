import React, { useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { Toolbar } from './ViewerTabs/Toolbar';
import { MPRView } from './ViewerTabs/MPR/MPRView';
import { CPRView } from './ViewerTabs/CPR/CPRView';

export const Viewer: React.FC = () => {
  const { setActiveStudy } = useAppContext();
  const [activeTab, setActiveTab] = useState<'mpr' | 'cpr'>('mpr');
  const [activeTool, setActiveTool] = useState('Crosshairs');
  const [windowWidth, setWindowWidth] = useState(400);
  const [windowCenter, setWindowCenter] = useState(40);
  const [slabThickness, setSlabThickness] = useState(0.1);

  const handleFlipHorizontal = () => {
    console.log("Flip Horizontal");
  };

  const handleFlipVertical = () => {
    console.log("Flip Vertical");
  };

  return (
    <div className="h-full w-full flex flex-col bg-black text-white overflow-hidden">
      <div className="h-12 bg-card border-b border-border flex items-center px-4 justify-between shrink-0 text-foreground">
        <h2 className="font-semibold">3Dent MPR Viewer</h2>
        <button
          onClick={() => setActiveStudy(null)}
          className="px-3 py-1.5 bg-destructive text-destructive-foreground rounded-md text-sm hover:opacity-90"
        >
          Закрыть исследование
        </button>
      </div>

      <Toolbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        activeTool={activeTool}
        setActiveTool={setActiveTool}
        windowWidth={windowWidth}
        setWindowWidth={setWindowWidth}
        windowCenter={windowCenter}
        setWindowCenter={setWindowCenter}
        slabThickness={slabThickness}
        setSlabThickness={setSlabThickness}
        onFlipHorizontal={handleFlipHorizontal}
        onFlipVertical={handleFlipVertical}
      />

      <div className="flex-1 overflow-hidden relative">
        {activeTab === 'mpr' ? (
          <MPRView
             windowWidth={windowWidth}
             windowCenter={windowCenter}
             slabThickness={slabThickness}
             activeTool={activeTool}
          />
        ) : (
          <CPRView
             windowWidth={windowWidth}
             windowCenter={windowCenter}
             activeTool={activeTool === 'Crosshairs' ? 'Spline' : activeTool}
          />
        )}
      </div>
    </div>
  );
};
