package dev.momo.task;
import java.util.Optional;
/** Bounded normal-projectile prediction in blocks / game tick. No entity mutation. */
public final class ProjectileAim {
 public record Shot(double x,double y,double z,double flightTicks){}
 private ProjectileAim(){}
 public static Optional<Shot> solve(double x,double y,double z,double vx,double vy,double vz,double speed,double gravity){
  for(double v:new double[]{x,y,z,vx,vy,vz,speed,gravity})if(!Double.isFinite(v))return Optional.empty();
  if(speed<=0||gravity<=0)return Optional.empty();
  double time=Math.hypot(x,z)/speed,px=x,py=y,pz=z,aimY=y;
  for(int i=0;i<4;i++){
   px=x+vx*time;py=y+vy*time;pz=z+vz*time;double distance=Math.hypot(px,pz);
   if(distance<.001)return Optional.of(new Shot(px,py,pz,Math.abs(py)/speed));
   double v2=speed*speed,discriminant=v2*v2-gravity*(gravity*distance*distance+2*py*v2);
   if(discriminant<0)return Optional.empty();
   double tangent=(v2-Math.sqrt(discriminant))/(gravity*distance);
   aimY=tangent*distance;time=distance*Math.sqrt(1+tangent*tangent)/speed;
   if(!Double.isFinite(time)||time>60)return Optional.empty();
  }
  return Optional.of(new Shot(px,aimY,pz,time));
 }
 public static boolean block(boolean shield,boolean windingUp,boolean incoming,boolean readyStrike){return shield&&!readyStrike&&(windingUp||incoming);}
}
