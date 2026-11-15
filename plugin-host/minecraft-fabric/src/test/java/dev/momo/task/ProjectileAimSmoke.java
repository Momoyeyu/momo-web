package dev.momo.task;
public final class ProjectileAimSmoke {
 private static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 public static void main(String[] args){
  var straight=ProjectileAim.solve(0,0,15,0,0,0,3,.05).orElseThrow();
  check(straight.y()>0&&straight.y()<2,"a normal bow must compensate gravity rather than aim along a straight horizontal ray");
  check(Math.abs(straight.y()-.5*.05*straight.flightTicks()*straight.flightTicks())<1e-6,"the predicted projectile must reach the actual target height");
  var moving=ProjectileAim.solve(0,0,15,.2,0,0,3,.05).orElseThrow();
  check(moving.x()>.9&&moving.x()<1.2,"a target strafing during the arrow flight must be led, not aimed at its old location");
  check(ProjectileAim.solve(0,40,10,0,0,0,1,.05).isEmpty(),"unreachable ballistic solutions must not produce NaN aim");
  check(ProjectileAim.solve(Double.NaN,0,10,0,0,0,3,.05).isEmpty(),"invalid observations cannot turn the character by a non-finite angle");
  check(ProjectileAim.block(false,true,false,false)==false,"no equipped shield means no invented blocking ability");
  check(ProjectileAim.block(true,true,false,false),"approaching a charging archer should block before melee reach");
  check(ProjectileAim.block(true,false,true,false),"an incoming projectile needs protection between attacks");
  check(!ProjectileAim.block(true,true,true,true),"a ready melee strike releases the shield instead of deadlocking combat");
  System.out.println("PASS ballistic gravity/lead and continuous shield timing");
 }
}
