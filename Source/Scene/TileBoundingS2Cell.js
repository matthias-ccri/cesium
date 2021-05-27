import Cartesian3 from "../Core/Cartesian3.js";
import CesiumMath from "../Core/Math.js";
import defined from "../Core/defined.js";
import Cartographic from "../Core/Cartographic.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import Intersect from "../Core/Intersect.js";
import Matrix3 from "../Core/Matrix3.js";
import Plane from "../Core/Plane.js";
import CoplanarPolygonOutlineGeometry from "../Core/CoplanarPolygonOutlineGeometry.js";
import BoundingSphere from "../Core/BoundingSphere.js";
import Check from "../Core/Check.js";
import ColorGeometryInstanceAttribute from "../Core/ColorGeometryInstanceAttribute.js";
import defaultValue from "../Core/defaultValue.js";
import GeometryInstance from "../Core/GeometryInstance.js";
import Matrix4 from "../Core/Matrix4.js";
import PerInstanceColorAppearance from "./PerInstanceColorAppearance.js";
import Primitive from "./Primitive.js";
import OrientedBoundingBox from "../Core/OrientedBoundingBox.js";
import S2Cell from "../Core/S2Cell.js";

var centerCartographicScratch = new Cartographic();
var scratchCartographic = new Cartographic();
/**
 * A tile bounding volume specified as an S2 cell token with minimum and maximum heights.
 * The bounding volume is a k DOP. A k-DOP is the Boolean intersection of extents along k directions.
 *
 * @alias TileBoundingS2Cell
 * @constructor
 *
 * @param {Object} options Object with the following properties:
 * @param {String} options.token The token of the S2 cell.
 * @param {Number} [options.minimumHeight=0.0] The minimum height of the bounding volume.
 * @param {Number} [options.maximumHeight=0.0] The maximum height of the bounding volume.
 * @param {Ellipsoid} [options.ellipsoid=Ellipsoid.WGS84] The ellipsoid.
 * @param {Boolean} [options.computeBoundingVolumes=true] True to compute the {@link TileBoundingS2Cell#boundingVolume} and
 *                  {@link TileBoundingS2Cell#boundingSphere}. If false, these properties will be undefined.
 *
 * @private
 */
function TileBoundingS2Cell(options) {
  //>>includeStart('debug', pragmas.debug);
  Check.typeOf.object("options", options);
  Check.typeOf.string("options.token", options.token);
  //>>includeEnd('debug');

  var s2Cell = S2Cell.fromToken(options.token);
  var minimumHeight = defaultValue(options.minimumHeight, 0.0);
  var maximumHeight = defaultValue(options.maximumHeight, 0.0);
  var ellipsoid = defaultValue(options.ellipsoid, Ellipsoid.WGS84);

  this.s2Cell = s2Cell;
  this.minimumHeight = minimumHeight;
  this.maximumHeight = maximumHeight;
  this.ellipsoid = ellipsoid;

  var boundingPlanes = computeBoundingPlanes(
    s2Cell,
    minimumHeight,
    maximumHeight,
    ellipsoid
  );
  this._boundingPlanes = boundingPlanes;

  // Pre-compute vertices to speed up the plane intersection test.
  var vertices = computeVertices(boundingPlanes);
  this._vertices = vertices;

  // Pre-compute edge normals to speed up the point-polygon distance check in distanceToCamera.
  this._edgeNormals = new Array(6);
  this._edgeNormals[0] = computeEdgeNormals(
    boundingPlanes[0],
    vertices.slice(0, 4)
  );
  this._edgeNormals[1] = computeEdgeNormals(
    boundingPlanes[1],
    vertices.slice(4, 8)
  );
  var i;
  for (i = 0; i < 4; i++) {
    this._edgeNormals[2 + i] = computeEdgeNormals(boundingPlanes[2 + i], [
      vertices[i % 4],
      vertices[4 + i],
      vertices[4 + ((i + 1) % 4)],
      vertices[(i + 1) % 4],
    ]);
  }

  var center = s2Cell.getCenter();
  centerCartographicScratch = ellipsoid.cartesianToCartographic(
    center,
    centerCartographicScratch
  );
  centerCartographicScratch.height = (maximumHeight + minimumHeight) / 2;
  this.center = ellipsoid.cartographicToCartesian(
    centerCartographicScratch,
    center
  );

  var points = new Array(7);

  // Add center of cell.
  points[0] = center;
  scratchCartographic = Cartographic.fromCartesian(points[0]);
  scratchCartographic.height = this.maximumHeight;
  points[0] = Cartographic.toCartesian(scratchCartographic);
  scratchCartographic.height = this.minimumHeight;
  points[1] = Cartographic.toCartesian(scratchCartographic);
  for (i = 0; i <= 3; i++) {
    scratchCartographic = Cartographic.fromCartesian(this.s2Cell.getVertex(i));
    scratchCartographic.height = this.maximumHeight;
    points[2 + i] = Cartographic.toCartesian(scratchCartographic);
    scratchCartographic.height = this.minimumHeight;
    points[2 + i + 1] = Cartographic.toCartesian(scratchCartographic);
  }
  this._orientedBoundingBox = OrientedBoundingBox.fromPoints(points);
  this._boundingSphere = BoundingSphere.fromOrientedBoundingBox(
    this._orientedBoundingBox
  );
}

var centerGeodeticNormalScratch = new Cartesian3();
var topCartographicScratch = new Cartographic();
var topScratch = new Cartesian3();
var vertexCartographicScratch = new Cartographic();
var vertexScratch = new Cartesian3();
var vertexGeodeticNormalScratch = new Cartesian3();
var sideNormalScratch = new Cartesian3();
var sideScratch = new Cartesian3();
var topPlaneScratch = new Plane(Cartesian3.UNIT_X, 0.0);
var bottomPlaneScratch = new Plane(Cartesian3.UNIT_X, 0.0);
/**
 * Computes bounding planes of the kDOP.
 * @private
 */
function computeBoundingPlanes(
  s2Cell,
  minimumHeight,
  maximumHeight,
  ellipsoid
) {
  var planes = new Array(6);
  var centerPoint = s2Cell.getCenter();

  // Compute top plane.
  // - Get geodetic surface normal at the center of the S2 cell.
  // - Get center point at maximum height of bounding volume.
  // - Create top plane from surface normal and top point.
  var centerSurfaceNormal = ellipsoid.geodeticSurfaceNormal(
    centerPoint,
    centerGeodeticNormalScratch
  );
  var topCartographic = ellipsoid.cartesianToCartographic(
    centerPoint,
    topCartographicScratch
  );
  topCartographic.height = maximumHeight;
  var top = ellipsoid.cartographicToCartesian(topCartographic, topScratch);
  var topPlane = Plane.fromPointNormal(
    top,
    centerSurfaceNormal,
    topPlaneScratch
  );
  planes[0] = topPlane;

  // Compute bottom plane.
  // - Iterate through bottom vertices
  //   - Get distance from vertex to top plane
  // - Find longest distance from vertex to top plane
  // - Translate top plane by the distance
  var maxDistance = 0;
  var i;
  var vertex, vertexCartographic;
  for (i = 0; i < 4; i++) {
    vertex = s2Cell.getVertex(i);
    vertexCartographic = ellipsoid.cartesianToCartographic(
      vertex,
      vertexCartographicScratch
    );
    vertexCartographic.height = minimumHeight;
    var distance = Plane.getPointDistance(
      topPlane,
      ellipsoid.cartographicToCartesian(vertexCartographic, vertexScratch)
    );
    if (distance < maxDistance) {
      maxDistance = distance;
    }
  }
  var bottomPlane = Plane.clone(topPlane, bottomPlaneScratch);
  // Negate the normal of the bottom plane since we want all normals to point "outwards".
  bottomPlane.normal = Cartesian3.negate(
    bottomPlane.normal,
    bottomPlane.normal
  );
  bottomPlane.distance = bottomPlane.distance * -1 + maxDistance;
  planes[1] = bottomPlane;

  // Compute side planes.
  // - Iterate through vertices
  //   - Get a vertex and another vertex adjacent to it.
  //   - Compute midpoint of geodesic between two vertices.
  //   - Compute geodetic surface normal at center point.
  //   - Compute vector between vertices.
  //   - Compute normal of side plane. (cross product of top dir and side dir)
  for (i = 0; i < 4; i++) {
    vertex = s2Cell.getVertex(i);
    var adjacentVertex = s2Cell.getVertex((i + 1) % 4);
    var geodeticNormal = ellipsoid.geodeticSurfaceNormal(
      vertex,
      vertexGeodeticNormalScratch
    );
    var side = Cartesian3.subtract(adjacentVertex, vertex, sideScratch);
    var sideNormal = Cartesian3.cross(side, geodeticNormal, sideNormalScratch);
    sideNormal = Cartesian3.normalize(sideNormal, sideNormal);
    planes[2 + i] = Plane.fromPointNormal(vertex, sideNormal);
  }

  return planes;
}

var n0Scratch = new Cartesian3();
var n1Scratch = new Cartesian3();
var n2Scratch = new Cartesian3();
var x0Scratch = new Cartesian3();
var x1Scratch = new Cartesian3();
var x2Scratch = new Cartesian3();
var t0Scratch = new Cartesian3();
var t1Scratch = new Cartesian3();
var t2Scratch = new Cartesian3();
var f0Scratch = new Cartesian3();
var f1Scratch = new Cartesian3();
var f2Scratch = new Cartesian3();
var sScratch = new Cartesian3();
/**
 * Computes intersection of 3 planes.
 * @private
 */
function computeIntersection(p0, p1, p2) {
  n0Scratch = p0.normal;
  n1Scratch = p1.normal;
  n2Scratch = p2.normal;

  x0Scratch = Cartesian3.multiplyByScalar(p0.normal, -p0.distance, x0Scratch);
  x1Scratch = Cartesian3.multiplyByScalar(p1.normal, -p1.distance, x1Scratch);
  x2Scratch = Cartesian3.multiplyByScalar(p2.normal, -p2.distance, x2Scratch);

  f0Scratch = Cartesian3.multiplyByScalar(
    Cartesian3.cross(n1Scratch, n2Scratch, t0Scratch),
    Cartesian3.dot(x0Scratch, n0Scratch),
    f0Scratch
  );
  f1Scratch = Cartesian3.multiplyByScalar(
    Cartesian3.cross(n2Scratch, n0Scratch, t1Scratch),
    Cartesian3.dot(x1Scratch, n1Scratch),
    f1Scratch
  );
  f2Scratch = Cartesian3.multiplyByScalar(
    Cartesian3.cross(n0Scratch, n1Scratch, t2Scratch),
    Cartesian3.dot(x2Scratch, n2Scratch),
    f2Scratch
  );

  var matrix = new Matrix3(
    n0Scratch.x,
    n0Scratch.y,
    n0Scratch.z,
    n1Scratch.x,
    n1Scratch.y,
    n1Scratch.z,
    n2Scratch.x,
    n2Scratch.y,
    n2Scratch.z
  );
  var determinant = Matrix3.determinant(matrix);
  sScratch = Cartesian3.add(
    Cartesian3.add(f0Scratch, f1Scratch, sScratch),
    f2Scratch,
    sScratch
  );
  return new Cartesian3(
    sScratch.x / determinant,
    sScratch.y / determinant,
    sScratch.z / determinant
  );
}
/**
 * Compute the vertices of the kDOP.
 * @private
 */
function computeVertices(boundingPlanes) {
  var vertices = new Array(8);
  for (var i = 0; i < 4; i++) {
    // Vertices on the top plane.
    vertices[i] = computeIntersection(
      boundingPlanes[0],
      boundingPlanes[2 + ((i + 3) % 4)],
      boundingPlanes[2 + (i % 4)]
    );
    // Vertices on the bottom plane.
    vertices[i + 4] = computeIntersection(
      boundingPlanes[1],
      boundingPlanes[2 + ((i + 3) % 4)],
      boundingPlanes[2 + (i % 4)]
    );
  }
  return vertices;
}

var edgeScratch = new Cartesian3();
var edgeNormalScratch = new Cartesian3();
/**
 * Compute edge normals on a plane.
 * @private
 */
function computeEdgeNormals(plane, vertices) {
  var edgeNormals = [];
  for (var i = 0; i < 4; i++) {
    edgeScratch = Cartesian3.subtract(
      vertices[i],
      vertices[(i + 1) % 4],
      edgeScratch
    );
    edgeNormalScratch = Cartesian3.cross(
      plane.normal,
      edgeScratch,
      edgeNormalScratch
    );
    edgeNormalScratch = Cartesian3.normalize(
      edgeNormalScratch,
      edgeNormalScratch
    );
    edgeNormals[i] = Cartesian3.clone(edgeNormalScratch);
  }
  return edgeNormals;
}

Object.defineProperties(TileBoundingS2Cell.prototype, {
  /**
   * The underlying bounding volume.
   *
   * @memberof TileOrientedBoundingBox.prototype
   *
   * @type {Object}
   * @readonly
   */
  boundingVolume: {
    get: function () {
      return this;
    },
  },
  /**
   * The underlying bounding sphere.
   *
   * @memberof TileOrientedBoundingBox.prototype
   *
   * @type {BoundingSphere}
   * @readonly
   */
  boundingSphere: {
    get: function () {
      return this._boundingSphere;
    },
  },
});

var facePointScratch = new Cartesian3();
/**
 * The distance to point check for this kDOP involves checking the signed distance of the point to each bounding
 * plane. A plane qualifies for a distance check if the point being tested against is in the half-space in the direction
 * of the normal i.e. if the signed distance of the point from the plane is greater than 0.
 *
 * There are 4 possible cases for a point:
 *
 * Case I: There is only one plane selected.
 *
 *     \             X            /
 *      \                        /
 *  -----\----------------------/-----
 *        \                    /
 *         \                  /
 *          \                /
 *      -----\--------------/-----
 *            \            /
 *             \          /
 *
 * In this case, we project the point onto the plane and do a point polygon distance check to find the closest point on the polygon.
 * The point may lie inside the "face" of the polygon or outside. If it is outside, we need to determine which edges to test against.
 *
 * Case II: There are two planes selected.
 *
 *  X  \                          /
 *      \                        /
 *  -----\----------------------/-----
 *        \                    /
 *         \                  /
 *          \                /
 *      -----\--------------/-----
 *            \            /
 *             \          /
 *
 * In this case, the point will lie somewhere on the line created at the intersection of the selected planes.
 *
 * Case III: There are three planes selected.
 *
 *
 *     \                          /
 *      \                        /
 *  -----X----------------------/-----
 *        \                    /
 *         \                  /
 *          \                /
 *      -----\--------------/-----
 *            \            /
 *             \          /
 *
 * Note: The diagram above is not fully accurate because it's difficult to draw the true 3D picture with ASCII art.
 *
 * In this case, the point will lie on the vertex, at the intersection of the selected planes.
 *
 * Case IV: There are more than three planes selected.
 *
 *
 *     \                          /
 *      \                        /
 *  -----X----------------------/-----
 *        \                    /
 *         \                  /
 *          \                /
 *      -----\--------------/-----
 *            \            /
 *             \          /
 *              \        /
 *               \      /
 *                \    /
 *                 \  /
 *                  \/
 *                  /\
 *                 /  \
 *                   X
 *
 * Since we are on an ellipsoid, this will only happen in the bottom plane, which is what we will use for the distance test.
 */
TileBoundingS2Cell.prototype.distanceToCamera = function (frameState) {
  //>>includeStart('debug', pragmas.debug);
  Check.defined("frameState", frameState);
  //>>includeEnd('debug');

  var point = frameState.camera.positionWC;

  var selectedPlaneIndices = [];
  var vertices;
  var edgeNormals;
  var rotation;

  if (
    CesiumMath.greaterThan(
      Plane.getPointDistance(this._boundingPlanes[0], point),
      0,
      CesiumMath.EPSILON14
    )
  ) {
    selectedPlaneIndices.push(0);
    vertices = this._vertices.slice(0, 4);
    edgeNormals = this._edgeNormals[0];
    rotation = -1;
  } else if (
    CesiumMath.greaterThan(
      Plane.getPointDistance(this._boundingPlanes[1], point),
      0,
      CesiumMath.EPSILON14
    )
  ) {
    selectedPlaneIndices.push(1);
    vertices = this._vertices.slice(4, 8);
    edgeNormals = this._edgeNormals[1];
    rotation = 1;
  }

  var i;
  var sidePlaneIndex;
  for (i = 0; i < 4; i++) {
    sidePlaneIndex = 2 + i;
    if (
      CesiumMath.greaterThan(
        Plane.getPointDistance(this._boundingPlanes[sidePlaneIndex], point),
        0,
        CesiumMath.EPSILON14
      )
    ) {
      selectedPlaneIndices.push(2 + i);
      vertices = [
        this._vertices[i % 4],
        this._vertices[4 + i],
        this._vertices[4 + ((i + 1) % 4)],
        this._vertices[(i + 1) % 4],
      ];
      edgeNormals = this._edgeNormals[2 + i];
      rotation = -1;
    }
  }

  // Check if inside all planes.
  if (selectedPlaneIndices.length === 0) {
    return 0.0;
  }

  var facePoint;
  if (selectedPlaneIndices.length === 1) {
    var selectedPlane = this._boundingPlanes[selectedPlaneIndices[0]];
    facePoint = closestPointPolygon(
      Plane.projectPointOntoPlane(selectedPlane, point, facePointScratch),
      vertices,
      selectedPlane,
      edgeNormals,
      rotation
    );
    return Cartesian3.distance(facePoint, point);
  } else if (selectedPlaneIndices.length === 2) {
    // Find the vertices shared by the two planes.
    var edge = [];
    if (selectedPlaneIndices[0] === 0) {
      edge = [
        this._vertices[(selectedPlaneIndices[1] + 3) % 4],
        this._vertices[(selectedPlaneIndices[1] + 2) % 4],
      ];
    } else if (selectedPlaneIndices[0] === 1) {
      edge = [
        this._vertices[selectedPlaneIndices[1] % 4],
        this._vertices[(selectedPlaneIndices[1] + 1) % 4],
      ];
    } else {
      edge = [
        this._vertices[4 + ((selectedPlaneIndices[0] + 3) % 4)],
        this._vertices[(selectedPlaneIndices[0] + 3) % 4],
      ];
    }
    facePoint = closestPointLineSegment(point, edge[0], edge[1]);
    return Cartesian3.distance(facePoint, point);
  } else if (selectedPlaneIndices.length > 3) {
    facePoint = closestPointPolygon(
      Plane.projectPointOntoPlane(
        this._boundingPlanes[0],
        point,
        facePointScratch
      ),
      vertices,
      this._boundingPlanes[0],
      edgeNormals[0],
      1
    );
    return Cartesian3.distance(facePoint, point);
  }
  // Vertex is on top plane.
  if (selectedPlaneIndices[0] === 0) {
    return Cartesian3.distance(
      point,
      this._vertices[selectedPlaneIndices[1] % 4]
    );
  }

  // Vertex is on bottom plane.
  return Cartesian3.distance(
    point,
    this._vertices[4 + ((selectedPlaneIndices[0] + 1) % 4)]
  );
};

var dScratch = new Cartesian3();
var pL0Scratch = new Cartesian3();
/**
 * Finds point on a line segment closest to a given point.
 * @private
 */
function closestPointLineSegment(p, l0, l1) {
  var d = Cartesian3.subtract(l1, l0, dScratch);
  var pL0 = Cartesian3.subtract(p, l0, pL0Scratch);
  var t = Cartesian3.dot(d, pL0);

  if (t <= 0) {
    return l0;
  }

  var dMag = Cartesian3.dot(d, d);
  if (t >= dMag) {
    return l1;
  }

  t = t / dMag;
  return new Cartesian3(
    (1 - t) * l0.x + t * l1.x,
    (1 - t) * l0.y + t * l1.y,
    (1 - t) * l0.z + t * l1.z
  );
}

var edgePlaneScratch = new Plane(Cartesian3.UNIT_X, 0.0);
/**
 * Finds closes point on the polygon, created by the given vertices, from
 * a point. The test point and the polygon are all on the same plane.
 * @private
 */
function closestPointPolygon(p, vertices, plane, edgeNormals, dir) {
  var minDistance = Number.MAX_VALUE;
  var distance;
  var closestPoint;
  var closestPointOnEdge;

  for (var i = 0; i < vertices.length; i++) {
    var edgePlane = Plane.fromPointNormal(
      vertices[i],
      edgeNormals[i],
      edgePlaneScratch
    );
    var edgePlaneDistance = Plane.getPointDistance(edgePlane, p);

    if (dir * edgePlaneDistance > 0) {
      continue;
    }

    closestPointOnEdge = closestPointLineSegment(
      p,
      vertices[i],
      vertices[(i + 1) % 4]
    );

    distance = Cartesian3.distance(p, closestPointOnEdge);
    if (distance < minDistance) {
      minDistance = distance;
      closestPoint = closestPointOnEdge;
    }
  }

  if (!defined(closestPoint)) {
    return p;
  }
  return closestPoint;
}

/**
 * Determines which side of a plane this volume is located.
 *
 * @param {Plane} plane The plane to test against.
 * @returns {Intersect} {@link Intersect.INSIDE} if the entire volume is on the side of the plane
 *                      the normal is pointing, {@link Intersect.OUTSIDE} if the entire volume is
 *                      on the opposite side, and {@link Intersect.INTERSECTING} if the volume
 *                      intersects the plane.
 */
TileBoundingS2Cell.prototype.intersectPlane = function (plane) {
  //>>includeStart('debug', pragmas.debug);
  Check.defined("plane", plane);
  //>>includeEnd('debug');

  var plusCount = 0;
  var negCount = 0;
  for (var i = 0; i < this._vertices.length; i++) {
    var distanceToPlane =
      Cartesian3.dot(plane.normal, this._vertices[i]) + plane.distance;
    if (distanceToPlane < 0) {
      negCount++;
    } else {
      plusCount++;
    }
  }

  if (plusCount === this._vertices.length) {
    return Intersect.INSIDE;
  } else if (negCount === this._vertices.length) {
    return Intersect.OUTSIDE;
  }
  return Intersect.INTERSECTING;
};

/**
 * Creates a debug primitive that shows the outline of the tile bounding
 * volume.
 *
 * @param {Color} color The desired color of the primitive's mesh
 * @return {Primitive}
 */
TileBoundingS2Cell.prototype.createDebugVolume = function (color) {
  //>>includeStart('debug', pragmas.debug);
  Check.defined("color", color);
  //>>includeEnd('debug');

  var modelMatrix = new Matrix4.clone(Matrix4.IDENTITY);
  var topPlanePolygon = new CoplanarPolygonOutlineGeometry({
    polygonHierarchy: {
      positions: this._vertices.slice(0, 4),
    },
  });
  var topPlaneGeometry = CoplanarPolygonOutlineGeometry.createGeometry(
    topPlanePolygon
  );
  var topPlaneInstance = new GeometryInstance({
    geometry: topPlaneGeometry,
    id: "topPlane",
    modelMatrix: modelMatrix,
    attributes: {
      color: ColorGeometryInstanceAttribute.fromColor(color),
    },
  });

  var bottomPlanePolygon = new CoplanarPolygonOutlineGeometry({
    polygonHierarchy: {
      positions: this._vertices.slice(4),
    },
  });
  var bottomPlaneGeometry = CoplanarPolygonOutlineGeometry.createGeometry(
    bottomPlanePolygon
  );
  var bottomPlaneInstance = new GeometryInstance({
    geometry: bottomPlaneGeometry,
    id: "outline",
    modelMatrix: modelMatrix,
    attributes: {
      color: ColorGeometryInstanceAttribute.fromColor(color),
    },
  });

  var sideInstances = [];
  for (var i = 0; i < 4; i++) {
    var sidePlanePolygon = new CoplanarPolygonOutlineGeometry({
      polygonHierarchy: {
        positions: [
          this._vertices[i % 4],
          this._vertices[4 + i],
          this._vertices[4 + ((i + 1) % 4)],
          this._vertices[(i + 1) % 4],
        ],
      },
    });
    var sidePlaneGeometry = CoplanarPolygonOutlineGeometry.createGeometry(
      sidePlanePolygon
    );
    sideInstances[i] = new GeometryInstance({
      geometry: sidePlaneGeometry,
      id: "outline",
      modelMatrix: modelMatrix,
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(color),
      },
    });
  }

  return new Primitive({
    geometryInstances: [
      sideInstances[0],
      sideInstances[1],
      sideInstances[2],
      sideInstances[3],
      bottomPlaneInstance,
      topPlaneInstance,
    ],
    appearance: new PerInstanceColorAppearance({
      translucent: false,
      flat: true,
    }),
    asynchronous: false,
  });
};
export default TileBoundingS2Cell;
