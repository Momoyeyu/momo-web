package dev.momo.task;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import baritone.api.Settings;
import java.util.LinkedHashMap;
import java.util.Map;
import baritone.api.pathing.goals.GoalNear;
import net.minecraft.client.MinecraftClient;
import net.minecraft.util.math.BlockPos;

/** API-only ownership. Discovery/mining scans and arbitrary Baritone commands are not exposed. */
public final class BaritoneNavigator {
 private IBaritone baritone;
 private GoalNear goal;
 private int warmup,pendingTicks;
 private boolean started,pending;
 private static IBaritone releasedByUs;
 private final Map<Settings.Setting<Boolean>,Boolean> settings=new LinkedHashMap<>();
 private void override(Settings.Setting<Boolean> setting,boolean value){settings.putIfAbsent(setting,setting.value);setting.value=value;}
 public void start(int x,int y,int z){
  baritone=BaritoneAPI.getProvider().getPrimaryBaritone();
  if(baritone.getPathingBehavior().isPathing()||baritone.getCustomGoalProcess().isActive()||(baritone.getPathingBehavior().getInProgress().isPresent()&&baritone!=releasedByUs))throw new IllegalStateException("Another navigator owns control");
  var config=BaritoneAPI.getSettings();
  override(config.allowBreak,false);override(config.allowPlace,false);
  override(config.allowParkourPlace,false);override(config.allowWaterBucketFall,false);
  override(config.chatControl,false);override(config.chatControlAnyway,false);override(config.prefixControl,false);
  override(config.freeLook,false);override(config.renderPath,false);override(config.renderGoal,false);
  override(config.chunkCaching,false);
  goal=new GoalNear(new BlockPos(x,y,z),1);
  warmup=4;
  pendingTicks=0;started=false;pending=baritone.getPathingBehavior().getInProgress().isPresent();
  if(!pending)begin();
 }
 private void begin(){baritone.getCustomGoalProcess().setGoalAndPath(goal);started=true;pending=false;warmup=4;}
 public void stop(){
  if(baritone!=null&&goal!=null&&started){baritone.getCustomGoalProcess().setGoal(null);baritone.getPathingBehavior().cancelEverything();baritone.getInputOverrideHandler().clearAllKeys();releasedByUs=baritone;}
  goal=null;pending=started=false;
  settings.forEach((key,value)->key.value=value);settings.clear();
 }
 public boolean arrived(){
  var client=MinecraftClient.getInstance();
  return goal!=null&&client.player!=null&&goal.isInGoal(client.player.getBlockPos());
 }
 public boolean failed(){
  if(pending){if(++pendingTicks>20)return true;if(!baritone.getPathingBehavior().getInProgress().isPresent()&&!baritone.getPathingBehavior().isPathing()&&!baritone.getCustomGoalProcess().isActive())begin();return false;}
  if(warmup-->0)return false;
  return baritone!=null&&!baritone.getCustomGoalProcess().isActive()&&!baritone.getPathingBehavior().isPathing();
 }
 public static boolean available(){return BaritoneAPI.getProvider().getPrimaryBaritone()!=null;}
}
