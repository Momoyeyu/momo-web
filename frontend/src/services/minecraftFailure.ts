/** Only reviewed reason codes reach the UI; arbitrary bridge text stays internal. */
const reasons:Record<string,string>={
 target_not_visible:'target',target_lost:'target',drop_gone_without_own_pickup:'target',source_not_visible:'source',
 unreachable:'path',outside_known_terrain:'path',tool_required:'tool',material_missing:'materials',food_missing:'materials',
 placement_blocked_or_material_missing:'materials',ingredients_station_or_server_ack_missing:'station',station_required:'station',
 recipe_unknown:'station',trade_unavailable:'station',trade_stock_or_currency_missing:'materials',
 inventory_full:'inventory',cursor_not_empty:'inventory',screen_changed:'station',station_screen_changed:'station',
 lease_expired:'connection',world_unavailable:'connection',identity_or_life_changed:'connection',
 skill_timeout:'timeout',gather_timeout:'timeout',processing_result_timeout:'timeout',
};
export function minecraftFailureKey(reason:string){
 const key=reasons[reason.replace(/^step_\d+:/,'')];
 return key?`minecraft.reason.${key}`:'minecraft.blockedHint';
}
