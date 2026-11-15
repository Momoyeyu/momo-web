/** Only reviewed reason codes reach the UI; arbitrary bridge text stays internal. */
const reasons:Record<string,string>={
 target_not_visible:'target',target_lost:'target',drop_gone_without_own_pickup:'target',source_not_visible:'source',
 unreachable:'path',outside_known_terrain:'path',tool_required:'tool',material_missing:'materials',food_missing:'materials',
 placement_blocked_or_material_missing:'materials',ingredients_station_or_server_ack_missing:'station',station_required:'station',
 materials_missing:'materials',item_missing:'materials',build_blocked:'build',build_incomplete:'build',build_target_occupied:'build',build_cells_not_visible:'target',build_timeout:'timeout',
 recipe_unknown:'station',trade_unavailable:'station',trade_stock_or_currency_missing:'materials',
 inventory_full:'inventory',cursor_not_empty:'inventory',screen_changed:'station',station_screen_changed:'station',
 lease_expired:'connection',world_unavailable:'connection',identity_or_life_changed:'connection',
 skill_timeout:'timeout',gather_timeout:'timeout',processing_result_timeout:'timeout',
 retreated_low_health:'retreat',
};
export function minecraftFailureKey(reason:string){
 const key=reasons[reason.replace(/^step_\d+:/,'')];
 return key?`minecraft.reason.${key}`:'minecraft.blockedHint';
}
const retreated=(state:string,reason:string)=>['failed','cancelled'].includes(state)&&minecraftFailureKey(reason)==='minecraft.reason.retreat';
export function minecraftTaskVisible(state:string,reason:string,skill=''){return skill!=='control'&&(['running','queued','paused','failed'].includes(state)||retreated(state,reason));}
export function minecraftTaskStateKey(state:string,reason:string){return `minecraft.taskState.${retreated(state,reason)?'retreated':state}`;}
