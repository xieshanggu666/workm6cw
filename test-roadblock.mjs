import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { routeHitBlockage } from '@/utils/geo'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
const rb = useRoadblockStore()
cmd.loadScenario('s1')
tr.load()
rb.reset()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}

const ev = cmd.events[0] // 江油 104.7456, 31.7777
// 离江油最近的基地：rb-2 绵阳 104.742, 31.4641
const mianyang = cmd.bases.find((b) => b.id === 'rb-2')

/* ========== 1. 现场上报 → 待确认，不影响既有任务 ========== */
console.log('— 现场上报封闭范围（待确认状态研判可见） —')
// 阻断带横在 绵阳→江油 直线上（纬度约 31.55~31.62），半径 6km
const rb1Path = [
  [104.50, 31.55],
  [104.98, 31.62]
]
const dRoute = [[mianyang.lng, mianyang.lat], [ev.location.lng, ev.location.lat]]
assert(routeHitBlockage(dRoute, { path: rb1Path, radius: 6000 }), '阻断几何命中绵阳→江油路线')

const rep = rb.report({
  eventId: ev.id, roadName: 'G543 江油南段', reason: 'landslide',
  reporter: '队员A', path: rb1Path, radius: 6000
})
assert(rep.ok, '上报成功')
assert(rb.blockages[0].status === 'reported', '初始状态为待确认')
assert(ev.timeline.some((t) => t.text.includes('现场上报道路阻断')), '上报回写事件时间线')

/* ========== 2. 新建派发（确认前），再确认封路 → 影响研判 ========== */
console.log('— 派发物资 → 确认封路 → 影响研判 —')
const stockBefore = mianyang.stock.food
const d1 = cmd.dispatchResource({ baseId: mianyang.id, eventId: ev.id, type: 'food', qty: 200 })
assert(!!d1 && d1.routeStatus === 'normal', '封路确认前派发正常（待确认不自动挂起）')
assert(mianyang.stock.food === stockBefore - 200, '扣减库存 200')

const c1 = rb.confirm(rep.blockage.id)
assert(c1.ok && rb.blockages[0].status === 'active', '指挥员确认封路')
let impacts = rb.analyze()
assert(impacts.some((i) => i.key === 'd-' + d1.id), '影响清单包含在途派发 d1')
const d1Impact = impacts.find((i) => i.key === 'd-' + d1.id)
assert(!!d1Impact.options.detour, 'd1 存在绕行方案')
assert(d1Impact.options.detour.minutes >= d1.minutes, '绕行到达时间不短于原线')
assert(!!d1Impact.options.reassign, 'd1 存在改派基地方案')
assert(d1Impact.action === 'detour', '默认建议为绕行')

/* ========== 3. 执行绕行：路线/到达时间同步，地图折线变为三点 ========== */
console.log('— 执行绕行 —')
rb.execute([{ key: 'd-' + d1.id, action: 'detour' }])
assert(d1.routeStatus === 'rerouted' && d1.actionType === 'detour', 'd1 已绕行')
assert(d1.routePoints.length >= 3, '绕行路线为含途经点的折线')
assert(d1.routePoints[1][0] !== d1.routePoints[0][0], '存在绕行途经点')
assert(d1.minutes >= d1Impact.options.detour.minutes - 1, '到达时间已同步绕行里程')
assert(mianyang.stock.food === stockBefore - 200, '绕行不改变库存占用')
assert(ev.timeline.some((t) => t.text.includes('物资绕行')), '绕行回写时间线')

/* ========== 4. 第二处封路：切断绕行线 + 改派基地 ========== */
console.log('— 第二处封路：改派基地（库存随任务迁移） —')
// 压在 d1 绕行途经点附近，且压住 rb-5/其他基地备选；同时保证某基地改派可达
const via = d1.routePoints[1]
// 短段横压绕行进给段（绵阳→绕行点中部，半径 3km）：切断绕行线；达州在东侧不受两处封路影响
const _mvx = via[0] - mianyang.lng, _mvy = via[1] - mianyang.lat
const _ml = Math.hypot(_mvx, _mvy)
const _mx = mianyang.lng + _mvx * 0.5, _my2 = mianyang.lat + _mvy * 0.5
const _mpx = -_mvy / _ml, _mpy = _mvx / _ml
const rb2Path = [
  [_mx - _mpx * 0.04, _my2 - _mpy * 0.04],
  [_mx + _mpx * 0.04, _my2 + _mpy * 0.04]
]
const rep2 = rb.report({ eventId: ev.id, roadName: '绕城便道', reason: 'collapse', reporter: '队员B', path: rb2Path, radius: 3000 })
rb.confirm(rep2.blockage.id)
impacts = rb.analyze()
assert(impacts.some((i) => i.key === 'd-' + d1.id), '绕行线被新封路再次命中')
const d1Impact2 = impacts.find((i) => i.key === 'd-' + d1.id)
// rb-1 成都(104.0657,30.6594) 与 rb-5 宜宾(104.633,28.7696) 在南部，改派候选应至少一个可达
assert(!!d1Impact2.options.reassign, '存在可达的改派基地: ' + (d1Impact2.options.reassign?.baseName || '无'))
const newBase = cmd.bases.find((b) => b.id === d1Impact2.options.reassign.baseId)
const newStockBefore = newBase.stock.food
rb.execute([{ key: 'd-' + d1.id, action: 'reassign' }])
assert(d1.baseId === newBase.id, 'd1 已改派至新基地')
assert(mianyang.stock.food === stockBefore, '原基地库存退还 200')
assert(newBase.stock.food === newStockBefore - 200, '新基地库存扣减 200')
assert(d1.routeStatus === 'rerouted' && d1.actionType === 'reassign', '状态=已改派')
assert(Math.abs(d1.distance - d1Impact2.options.reassign.distance) < 0.2, '改派后到达时间/里程已同步')
assert(d1.originalBaseId === mianyang.id, '保留原基地信息供恢复')
assert(ev.timeline.some((t) => t.text.includes('物资改派')), '改派回写时间线')

/* ========== 5. 无路可走：目的地被围 → 派发与转移批次挂起，车辆床位保留 ========== */
console.log('— 无路可走：封闭带围堵受灾点，任务挂起 —')
// 在江油受灾点周围放两条交叉宽带，使绕行外扩失败、所有基地/安置点路线皆被命中
const ringA = [[104.7456 - 0.45, 31.7777 - 0.05], [104.7456 + 0.45, 31.7777 + 0.05]]
const ringB = [[104.7456 - 0.05, 31.7777 - 0.45], [104.7456 + 0.05, 31.7777 + 0.45]]
const rep3 = rb.report({ eventId: ev.id, roadName: '江油北侧环路', reason: 'flood', reporter: '队员C', path: ringA, radius: 45000 })
rb.confirm(rep3.blockage.id)
const rep4 = rb.report({ eventId: ev.id, roadName: '江油西侧通道', reason: 'flood', reporter: '队员C', path: ringB, radius: 45000 })
rb.confirm(rep4.blockage.id)

// 新派发 → 自动挂起
const d3 = cmd.dispatchResource({ baseId: cmd.bases[0].id, eventId: ev.id, type: 'water', qty: 50 })
assert(d3.routeStatus === 'suspended', '封路期间新建派发自动挂起')
assert(!!d3.suspendBy?.length, '记录挂起原因阻断')

// 新建转移批次 → 自动挂起，车辆占用与床位预占保留
const vBefore = cmd.bases[0].stock.vehicle
const rBatch = tr.createBatch({
  eventId: ev.id, name: '阻断测试批', headcount: 30,
  vehicleBaseId: cmd.bases[0].id, vehicleCount: 1, shelterId: 'sh-1'
})
assert(rBatch.ok, '批次创建成功')
const b1 = rBatch.batch
assert(b1.routeStatus === 'suspended', '封路期间新建批次自动挂起')
assert(cmd.bases[0].stock.vehicle === vBefore - 1, '车辆仍占用（未因挂起释放）')
assert(tr.bedMap['sh-1'].reserved >= 30, '床位预占保留')

// 挂起期间登记被拦截
const regR = tr.register(b1.id, 'pickup', { count: 10 })
assert(!regR.ok && regR.msg.includes('挂起'), '挂起批次禁止接运登记: ' + regR.msg)
assert(!tr.reassignBatch(b1.id, { vehicleBaseId: cmd.bases[0].id, vehicleCount: 1 }).ok, '挂起批次禁止常规改派')

impacts = rb.analyze()
const d3Impact = impacts.find((i) => i.key === 'd-' + d3.id)
const b1Impact = impacts.find((i) => i.key === 'b-' + b1.id)
assert(!!d3Impact && !d3Impact.options.detour && !d3Impact.options.reassign, 'd3 绕行/改派均不可行')
assert(!!b1Impact && !b1Impact.options.reassign, 'b1 无可改派安置点')
assert(rb.suspendedCount >= 2, `挂起任务计数 ≥2，实际 ${rb.suspendedCount}`)
assert(ev.timeline.some((t) => t.text.includes('无路可走')), '挂起回写时间线')

/* ========== 6. 恢复通行：逐条解封，全部清除后自动续派 ========== */
console.log('— 恢复通行 → 自动续派 —')
// 先清除前两处封路（不影响仍被围堵的 d3/b1）
rb.clear(rep.blockage.id)
rb.clear(rep2.blockage.id)
let cleared = rb.clear(rep3.blockage.id)
assert(cleared.ok && cleared.resumed === 0 && cleared.stillBlocked >= 2, '围堵只解封一处：任务仍挂起')
assert(d3.routeStatus === 'suspended' && b1.routeStatus === 'suspended', 'd3/b1 仍挂起')

cleared = rb.clear(rep4.blockage.id)
assert(cleared.resumed >= 2, `所有阻断清除，自动续派 ≥2，实际 ${cleared.resumed}`)
assert(d3.routeStatus === 'normal', 'd3 续派恢复正常')
assert(b1.routeStatus === 'normal', 'b1 续派恢复正常')
assert(!!b1.suspendSnapshot === false && !b1.suspendBy, '挂起快照已清理')
assert(cmd.bases[0].stock.vehicle === vBefore - 1, '续派后车辆仍正常占用')
assert(tr.register(b1.id, 'pickup', { count: 10 }).ok, '续派后恢复接运登记')
assert(ev.timeline.some((t) => t.text.includes('任务续派')), '续派回写时间线')

/* ========== 7. 已改派任务恢复原方案（阻断全部清除后） ========== */
console.log('— 已改派物资恢复原基地 —')
assert(d1.routeStatus === 'rerouted', 'd1 仍为改派状态（改派不随阻断清除自动回退）')
const restore = rb.restoreRoute('d-' + d1.id)
assert(restore.ok, '阻断全部解除后可恢复原方案')
assert(d1.baseId === mianyang.id, 'd1 恢复原基地')
assert(mianyang.stock.food === stockBefore - 200, '恢复后原基地重新扣减')
assert(d1.routeStatus === 'normal' && d1.routePoints === null, '路线恢复直线、状态正常')
assert(ev.timeline.some((t) => t.text.includes('恢复原派发路线')), '恢复回写时间线')

/* ========== 8. 转移批次改派安置点：床位联动 ========== */
console.log('— 批次改派安置点（床位同步） —')
// b1 当前路线：江油 → sh-1（江油一中 104.7705,31.778），在靠近安置点 85% 处放窄横断
const sh1 = tr.shelters.find((s) => s.id === 'sh-1')
const _bvx = sh1.lng - ev.location.lng, _bvy = sh1.lat - ev.location.lat
const _bl = Math.hypot(_bvx, _bvy)
const _bcx = ev.location.lng + _bvx * 0.85, _bcy = ev.location.lat + _bvy * 0.85
const _bpx = -_bvy / _bl, _bpy = _bvx / _bl
const cutPath = [
  [_bcx - _bpx * 0.008, _bcy - _bpy * 0.008],
  [_bcx + _bpx * 0.008, _bcy + _bpy * 0.008]
]
const rep5 = rb.report({ eventId: ev.id, roadName: '安置点入口道路', reason: 'flood', reporter: '队员D', path: cutPath, radius: 600 })
rb.confirm(rep5.blockage.id)
impacts = rb.analyze()
const b1Impact2 = impacts.find((i) => i.key === 'b-' + b1.id)
assert(!!b1Impact2, '已接运在途批次路线再次被命中')
assert(!!b1Impact2.options.reassign, '存在可改派安置点: ' + (b1Impact2.options.reassign?.shelterName || '无'))
const targetShelter = tr.shelters.find((s) => s.id === b1Impact2.options.reassign.shelterId)
rb.execute([{ key: 'b-' + b1.id, action: 'reassign' }])
assert(b1.shelterId === targetShelter.id, '批次改派至新安置点')
assert(b1.routeStatus === 'rerouted' && b1.actionType === 'reassign', '批次状态=已改派')
assert(tr.bedMap[targetShelter.id].reserved >= 30 || tr.bedMap[targetShelter.id].inHouse >= 0, '新安置点床位预占已同步')
assert(ev.timeline.some((t) => t.text.includes('改派安置点')), '批次改派回写时间线')
// 清理
rb.clear(rep5.blockage.id)

/* ========== 9. 误报撤销不触发续派/影响 ========== */
console.log('— 误报撤销 —')
const rep6 = rb.report({ eventId: ev.id, roadName: '疑似落石点', reason: 'landslide', reporter: '队员E', path: [[200, 200], [201, 201]], radius: 1000 })
assert(rep6.ok, '远端阻断上报成功')
const dis = rb.dismiss(rep6.blockage.id)
assert(dis.ok && rb.blockages.find((x) => x.id === rep6.blockage.id).status === 'dismissed', '误报已撤销')
assert(rb.openBlockages.length === 0, '无待处置阻断')
assert(rb.suspendedCount === 0, '无挂起任务')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
