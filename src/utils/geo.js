// 路网几何工具（演示用：等距圆柱投影近似，距离单位米）
// 路线 / 阻断段均为 [[lng, lat], ...] 折线；阻断带 = 折线两侧 radius 米缓冲
const M_PER_LAT = 111320

function project(p, ref) {
  const kx = M_PER_LAT * Math.cos((ref.lat * Math.PI) / 180)
  return { x: (p[0] - ref.lng) * kx, y: (p[1] - ref.lat) * M_PER_LAT }
}

// 点到线段距离（米）
export function pointSegmentDistanceM(p, a, b) {
  const ref = { lng: (p[0] + a[0] + b[0]) / 3, lat: (p[1] + a[1] + b[1]) / 3 }
  const P = project(p, ref)
  const A = project(a, ref)
  const B = project(b, ref)
  const vx = B.x - A.x
  const vy = B.y - A.y
  const l2 = vx * vx + vy * vy
  let t = l2 === 0 ? 0 : ((P.x - A.x) * vx + (P.y - A.y) * vy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(P.x - (A.x + t * vx), P.y - (A.y + t * vy))
}

// 点到线段的最近点（经纬度）
export function nearestPointOnSegment(p, a, b) {
  const ref = { lng: (p[0] + a[0] + b[0]) / 3, lat: (p[1] + a[1] + b[1]) / 3 }
  const P = project(p, ref)
  const A = project(a, ref)
  const B = project(b, ref)
  const vx = B.x - A.x
  const vy = B.y - A.y
  const l2 = vx * vx + vy * vy
  let t = l2 === 0 ? 0 : ((P.x - A.x) * vx + (P.y - A.y) * vy) / l2
  t = Math.max(0, Math.min(1, t))
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

// 两线段是否相交（含端点相接、共线重叠）
export function segmentsIntersect(a, b, c, d) {
  const e = 1e-12
  const o1 = cross(a, b, c)
  const o2 = cross(a, b, d)
  const o3 = cross(c, d, a)
  const o4 = cross(c, d, b)
  if (Math.abs(o1) <= e && onSegment(a, b, c)) return true
  if (Math.abs(o2) <= e && onSegment(a, b, d)) return true
  if (Math.abs(o3) <= e && onSegment(c, d, a)) return true
  if (Math.abs(o4) <= e && onSegment(c, d, b)) return true
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)
}
function onSegment(a, b, p) {
  return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
}

// 两线段交点（经纬度），不相交返回 null
export function intersectionPoint(a, b, c, d) {
  const x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1]
  const x3 = c[0], y3 = c[1], x4 = d[0], y4 = d[1]
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
  if (Math.abs(den) < 1e-15) return null
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)]
}

// 两线段之间距离（米）：相交为 0，否则取端点到对线段的最小距离
export function segmentDistanceM(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0
  return Math.min(
    pointSegmentDistanceM(a, c, d),
    pointSegmentDistanceM(b, c, d),
    pointSegmentDistanceM(c, a, b),
    pointSegmentDistanceM(d, a, b)
  )
}

// 路线折线是否进入某条阻断带
export function routeHitBlockage(route, rb) {
  for (let i = 0; i < route.length - 1; i++) {
    for (let j = 0; j < rb.path.length - 1; j++) {
      if (segmentDistanceM(route[i], route[i + 1], rb.path[j], rb.path[j + 1]) < rb.radius) return true
    }
  }
  return false
}

// 路线是否被任意一条阻断带命中
export function routeHitAny(route, list) {
  return list.some((rb) => routeHitBlockage(route, rb))
}

// 点是否落在阻断带内
export function pointInBlockages(p, list) {
  return list.some((rb) =>
    rb.path.some((v, j) => {
      if (j === rb.path.length - 1) return false
      return pointSegmentDistanceM(p, rb.path[j], rb.path[j + 1]) < rb.radius
    })
  )
}

// 路线与阻断带的最近接触点（位于路线上）及所在路线段，用于生成绕行点
export function nearestRouteContact(route, rbPath) {
  let best = { dist: Infinity, point: null, seg: null }
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1]
    for (let j = 0; j < rbPath.length - 1; j++) {
      const c = rbPath[j], d = rbPath[j + 1]
      const ip = intersectionPoint(a, b, c, d)
      if (ip) return { point: ip, seg: [a, b] }
      const cand = [
        { p: nearestPointOnSegment(c, a, b), dist: pointSegmentDistanceM(c, a, b) },
        { p: nearestPointOnSegment(d, a, b), dist: pointSegmentDistanceM(d, a, b) },
        { p: a, dist: pointSegmentDistanceM(a, c, d) },
        { p: b, dist: pointSegmentDistanceM(b, c, d) }
      ]
      cand.forEach((x) => {
        if (x.dist < best.dist) best = { dist: x.dist, point: x.p, seg: [a, b] }
      })
    }
  }
  return best.point ? best : null
}

// 以米为单位平移坐标点
export function offsetPointM(p, dxM, dyM) {
  const kx = M_PER_LAT * Math.cos((p[1] * Math.PI) / 180)
  return [p[0] + dxM / kx, p[1] + dyM / M_PER_LAT]
}
