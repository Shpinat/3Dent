import { getRenderingEngine, type VolumeViewport } from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';

export const TOOL_GROUP_ID = 'mpr-tool-group';

export function setupToolGroup() {
  let toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_ID);

  if (!toolGroup) {
    toolGroup = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_ID);

    // Add tools
    cornerstoneTools.addTool(cornerstoneTools.CrosshairsTool);
    cornerstoneTools.addTool(cornerstoneTools.WindowLevelTool);
    cornerstoneTools.addTool(cornerstoneTools.PanTool);
    cornerstoneTools.addTool(cornerstoneTools.ZoomTool);
    cornerstoneTools.addTool(cornerstoneTools.LengthTool);
    cornerstoneTools.addTool(cornerstoneTools.TrackballRotateTool);

    // Set tools active/passive
    toolGroup?.addTool(cornerstoneTools.CrosshairsTool.toolName);
    toolGroup?.addTool(cornerstoneTools.WindowLevelTool.toolName);
    toolGroup?.addTool(cornerstoneTools.PanTool.toolName);
    toolGroup?.addTool(cornerstoneTools.ZoomTool.toolName);
    toolGroup?.addTool(cornerstoneTools.LengthTool.toolName);
    toolGroup?.addTool(cornerstoneTools.TrackballRotateTool.toolName);

    // Bindings
    toolGroup?.setToolActive(cornerstoneTools.CrosshairsTool.toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
    });

    toolGroup?.setToolActive(cornerstoneTools.WindowLevelTool.toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
    });

    toolGroup?.setToolActive(cornerstoneTools.PanTool.toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }],
    });

    toolGroup?.setToolActive(cornerstoneTools.ZoomTool.toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary_And_Secondary }],
    });
  }

  return toolGroup;
}

export function syncWindowLevel(renderingEngineId: string, viewportIds: string[], windowWidth: number, windowCenter: number) {
    const renderingEngine = getRenderingEngine(renderingEngineId);
    if (!renderingEngine) return;

    viewportIds.forEach(vpId => {
        const vp = renderingEngine.getViewport(vpId) as VolumeViewport;
        if (vp) {
            vp.setProperties({ voiRange: { lower: windowCenter - windowWidth / 2, upper: windowCenter + windowWidth / 2 } });
            vp.render();
        }
    });
}
