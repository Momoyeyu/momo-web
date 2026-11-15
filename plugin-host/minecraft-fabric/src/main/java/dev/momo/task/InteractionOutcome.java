package dev.momo.task;
import java.util.Objects;
/** A click receipt starts at dispatch, not at the beginning of its approach. */
final class InteractionOutcome {
 record Hand(String item,int count,int damage,int slot){}
 record State(Object window,int handler,boolean serverContainer,long inventorySeq,String block,long blockSeq,int vehicle,boolean sleepingAtTarget,Hand hand,boolean heldConfirmed){}
 private final State before;private final int dispatchedAt,targetEntity;private final long inventoryBoundary,blockBoundary;
 private Object confirmedWindow;private boolean interrupted;
 InteractionOutcome(State before,int tick,long inventoryBoundary,long blockBoundary,int targetEntity){this.before=before;dispatchedAt=tick;this.inventoryBoundary=inventoryBoundary;this.blockBoundary=blockBoundary;this.targetEntity=targetEntity;}
 void confirmWindow(Object window){if(window!=null&&window!=before.window())confirmedWindow=window;}
 void invalidate(){interrupted=true;}
 boolean interrupted(){return interrupted;}
 boolean handCandidate(Hand hand,int handler){return !interrupted&&handler==before.handler()&&hand.slot()==before.hand().slot()&&handChanged(before.hand(),hand);}
 boolean ownsWindow(Object window,int handler,boolean serverContainer,boolean sleepingScreen,boolean sleepingAtTarget){
  if(interrupted||window==null||window==before.window())return false;
  if(window==confirmedWindow)return true; // Synchronous local call or target-bound server UI.
  return InteractionScreens.accepts(true,serverContainer&&handler!=before.handler(),sleepingScreen,!before.sleepingAtTarget()&&sleepingAtTarget);
 }
 String effect(State now,int tick){
  if(interrupted||tick-dispatchedAt<4)return "";
  if(targetEntity>=0&&before.vehicle()!=targetEntity&&now.vehicle()==targetEntity)return "mounted_target";
  if(targetEntity<0&&!before.sleepingAtTarget()&&now.sleepingAtTarget())return "sleeping";
  if(targetEntity<0&&now.blockSeq()>blockBoundary&&!Objects.equals(before.block(),now.block()))return "block_changed";
  if(now.window()!=null&&now.window()!=before.window()&&(now.window()==confirmedWindow||now.serverContainer()&&now.handler()!=before.handler()&&now.inventorySeq()>inventoryBoundary))return "screen_opened";
  if(now.heldConfirmed()&&handCandidate(now.hand(),now.handler()))return "held_item_changed";
  return "";
 }
 private static boolean handChanged(Hand before,Hand after){
  if(before.count()<=0||before.item().equals("minecraft:air"))return false;
  if(!before.item().equals(after.item()))return true;
  return after.count()<before.count()||after.count()==before.count()&&after.damage()>before.damage();
 }
}
