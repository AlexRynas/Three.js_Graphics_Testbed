import {
  CollectionAxisDirection,
  CollectionAxisRemap,
  CollectionNormalization,
  CollectionSourceTool,
  Vector3Tuple,
} from './controls.model';

export interface ResolvedCollectionNormalization {
  sourceTool: CollectionSourceTool;
  viewAxes: CollectionAxisRemap;
  viewScale: number;
  rootScale: number;
}

const IDENTITY_COLLECTION_AXES: CollectionAxisRemap = {
  x: 'x',
  y: 'y',
  z: 'z',
};

const VALID_AXES: readonly CollectionAxisDirection[] = ['x', 'y', 'z', '-x', '-y', '-z'];

const VALID_SOURCE_TOOLS: readonly CollectionSourceTool[] = [
  'threejs',
  'blender',
  'unreal',
  'unknown',
];

const DEFAULT_COLLECTION_NORMALIZATION: ResolvedCollectionNormalization = {
  sourceTool: 'threejs',
  viewAxes: IDENTITY_COLLECTION_AXES,
  viewScale: 1,
  rootScale: 1,
};

export function resolveCollectionNormalization(
  normalization?: CollectionNormalization | null,
): ResolvedCollectionNormalization {
  if (!normalization) {
    return DEFAULT_COLLECTION_NORMALIZATION;
  }

  const sourceTool = resolveSourceTool(normalization.sourceTool);

  return {
    sourceTool,
    viewAxes: resolveAxisRemap(normalization.viewAxes, sourceTool),
    viewScale: resolvePositiveNumber(normalization.viewScale, 'viewScale', sourceTool),
    rootScale: resolvePositiveNumber(normalization.rootScale, 'rootScale', sourceTool),
  };
}

export function transformCollectionVector(
  vector: Vector3Tuple,
  normalization: ResolvedCollectionNormalization,
): Vector3Tuple {
  const transformed: Vector3Tuple = [
    resolveAxisValue(vector, normalization.viewAxes.x) * normalization.viewScale,
    resolveAxisValue(vector, normalization.viewAxes.y) * normalization.viewScale,
    resolveAxisValue(vector, normalization.viewAxes.z) * normalization.viewScale,
  ];

  return transformed;
}

function resolveSourceTool(
  sourceTool: CollectionNormalization['sourceTool'],
): CollectionSourceTool {
  if (sourceTool && VALID_SOURCE_TOOLS.includes(sourceTool)) {
    return sourceTool;
  }

  if (sourceTool !== undefined) {
    warnNormalizationIssue(
      `Unsupported collection normalization sourceTool "${String(sourceTool)}"; falling back to "threejs".`,
    );
  }

  return DEFAULT_COLLECTION_NORMALIZATION.sourceTool;
}

function resolveAxisRemap(
  viewAxes: CollectionNormalization['viewAxes'],
  sourceTool: CollectionSourceTool,
): CollectionAxisRemap {
  if (!viewAxes) {
    return DEFAULT_COLLECTION_NORMALIZATION.viewAxes;
  }

  const candidate: CollectionAxisRemap = {
    x: resolveAxisDirection(viewAxes.x, 'x', sourceTool),
    y: resolveAxisDirection(viewAxes.y, 'y', sourceTool),
    z: resolveAxisDirection(viewAxes.z, 'z', sourceTool),
  };

  const absoluteAxes = new Set(Object.values(candidate).map((axis) => axis.replace('-', '')));
  if (absoluteAxes.size !== 3) {
    warnNormalizationIssue(
      `Collection normalization for "${sourceTool}" must map runtime axes to three distinct source axes; falling back to identity axes.`,
    );
    return DEFAULT_COLLECTION_NORMALIZATION.viewAxes;
  }

  return candidate;
}

function resolveAxisDirection(
  value: CollectionAxisDirection | undefined,
  axisName: keyof CollectionAxisRemap,
  sourceTool: CollectionSourceTool,
): CollectionAxisDirection {
  if (value && VALID_AXES.includes(value)) {
    return value;
  }

  if (value !== undefined) {
    warnNormalizationIssue(
      `Collection normalization axis "${axisName}" for "${sourceTool}" must be one of ${VALID_AXES.join(', ')}; falling back to identity axes.`,
    );
  }

  return IDENTITY_COLLECTION_AXES[axisName];
}

function resolvePositiveNumber(
  value: number | undefined,
  propertyName: 'viewScale' | 'rootScale',
  sourceTool: CollectionSourceTool,
): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (value !== undefined) {
    warnNormalizationIssue(
      `Collection normalization ${propertyName} for "${sourceTool}" must be a positive finite number; falling back to 1.`,
    );
  }

  return 1;
}

function resolveAxisValue(vector: Vector3Tuple, axis: CollectionAxisDirection): number {
  switch (axis) {
    case 'x':
      return vector[0];
    case 'y':
      return vector[1];
    case 'z':
      return vector[2];
    case '-x':
      return -vector[0];
    case '-y':
      return -vector[1];
    case '-z':
      return -vector[2];
  }
}

function warnNormalizationIssue(message: string): void {
  console.warn(`[CollectionNormalization] ${message}`);
}
