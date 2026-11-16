package dev.momo.task;

import net.minecraft.entity.Entity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.ai.RangedAttackMob;
import net.minecraft.entity.mob.BlazeEntity;
import net.minecraft.entity.mob.GhastEntity;
import net.minecraft.entity.mob.GuardianEntity;
import net.minecraft.item.BowItem;
import net.minecraft.item.CrossbowItem;
import net.minecraft.item.TridentItem;

/** Classify the already observed threat, never search for additional entities. */
final class ThreatRange {
 private ThreatRange(){}
 static boolean ranged(Entity target){
  if(target instanceof RangedAttackMob||target instanceof GhastEntity||target instanceof BlazeEntity||target instanceof GuardianEntity)return true;
  if(target instanceof LivingEntity living)for(var stack:living.getHandItems()){
   var item=stack.getItem();if(item instanceof BowItem||item instanceof CrossbowItem||item instanceof TridentItem)return true;
  }
  return false;
 }
}
