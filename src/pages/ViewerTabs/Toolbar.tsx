import React from 'react';
import { FlipHorizontal, FlipVertical, Sun, Contrast, MousePointer2, Ruler } from 'lucide-react';

interface ToolbarProps {
  activeTab: 'mpr' | 'cpr';
  setActiveTab: (tab: 'mpr' | 'cpr') => void;
  activeTool: string;
  setActiveTool: (tool: string) => void;
  windowWidth: number;
  setWindowWidth: (val: number) => void;
  windowCenter: number;
  setWindowCenter: (val: number) => void;
  slabThickness: number;
  setSlabThickness: (val: number) => void;
  onFlipHorizontal: () => void;
  onFlipVertical: () => void;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  activeTab,
  setActiveTab,
  activeTool,
  setActiveTool,
  windowWidth,
  setWindowWidth,
  windowCenter,
  setWindowCenter,
  slabThickness,
  setSlabThickness,
  onFlipHorizontal,
  onFlipVertical
}) => {
  return (
    <div className="h-16 bg-card border-b border-border flex items-center px-4 justify-between shrink-0 overflow-x-auto">
      <div className="flex items-center space-x-2 mr-6">
        <div className="flex bg-secondary p-1 rounded-md">
          <button
            onClick={() => setActiveTab('mpr')}
            className={`px-4 py-1.5 rounded-sm text-sm font-medium transition-colors ${
              activeTab === 'mpr' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            MPR
          </button>
          <button
            onClick={() => setActiveTab('cpr')}
            className={`px-4 py-1.5 rounded-sm text-sm font-medium transition-colors ${
              activeTab === 'cpr' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Панорама (CPR)
          </button>
        </div>
      </div>

      <div className="flex items-center space-x-6 flex-1">
        {/* Basic Tools */}
        <div className="flex items-center space-x-1 border-r border-border pr-6">
          <button
            onClick={() => setActiveTool('Crosshairs')}
            className={`p-2 rounded-md ${activeTool === 'Crosshairs' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
            title="Crosshairs (MPR Navigation)"
          >
            <MousePointer2 className="w-5 h-5" />
          </button>
          <button
            onClick={() => setActiveTool('Length')}
            className={`p-2 rounded-md ${activeTool === 'Length' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
            title="Length Tool"
          >
            <Ruler className="w-5 h-5" />
          </button>
        </div>

        {/* Orientation Tools */}
        <div className="flex items-center space-x-1 border-r border-border pr-6">
          <button onClick={onFlipHorizontal} className="p-2 rounded-md hover:bg-accent" title="Отразить по горизонтали">
            <FlipHorizontal className="w-5 h-5" />
          </button>
          <button onClick={onFlipVertical} className="p-2 rounded-md hover:bg-accent" title="Отразить по вертикали">
            <FlipVertical className="w-5 h-5" />
          </button>
        </div>

        {/* Window Level Controls */}
        <div className="flex items-center space-x-4 border-r border-border pr-6">
          <div className="flex items-center space-x-2">
            <Sun className="w-4 h-4 text-muted-foreground" />
            <div className="flex flex-col">
              <label className="text-[10px] text-muted-foreground uppercase">Яркость (Level)</label>
              <input
                type="range"
                min="-1000"
                max="3000"
                value={windowCenter}
                onChange={(e) => setWindowCenter(Number(e.target.value))}
                className="w-24 h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer"
              />
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <Contrast className="w-4 h-4 text-muted-foreground" />
            <div className="flex flex-col">
              <label className="text-[10px] text-muted-foreground uppercase">Контраст (Width)</label>
              <input
                type="range"
                min="1"
                max="4000"
                value={windowWidth}
                onChange={(e) => setWindowWidth(Number(e.target.value))}
                className="w-24 h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* Slab Thickness */}
        <div className="flex items-center space-x-2">
           <div className="flex flex-col">
              <label className="text-[10px] text-muted-foreground uppercase">Толщина среза (MIP)</label>
              <select
                value={slabThickness}
                onChange={(e) => setSlabThickness(Number(e.target.value))}
                className="bg-secondary border border-border rounded-md text-sm px-2 py-1 outline-none"
              >
                <option value={0.1}>0.1 мм</option>
                <option value={1}>1 мм</option>
                <option value={3}>3 мм</option>
                <option value={5}>5 мм</option>
                <option value={10}>10 мм</option>
                <option value={20}>20 мм</option>
              </select>
           </div>
        </div>
      </div>
    </div>
  );
};
