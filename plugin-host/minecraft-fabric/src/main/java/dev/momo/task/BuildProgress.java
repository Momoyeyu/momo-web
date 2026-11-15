package dev.momo.task;
/** Bounded physical progress; walking in circles is not verified construction. */
final class BuildProgress {
 private final int idleLimit,proofLimit;private int idle,withoutProof,bestConfirmed=-1;
 private double x,y,z;private boolean initialized;
 BuildProgress(int idleLimit,int proofLimit){if(idleLimit<1||proofLimit<idleLimit)throw new IllegalArgumentException("Invalid progress budget");this.idleLimit=idleLimit;this.proofLimit=proofLimit;}
 boolean blocked(int confirmed,double x,double y,double z){
  if(!initialized||confirmed>bestConfirmed){bestConfirmed=confirmed;idle=withoutProof=0;initialized=true;this.x=x;this.y=y;this.z=z;return false;}
  withoutProof++;
  if((x-this.x)*(x-this.x)+(y-this.y)*(y-this.y)+(z-this.z)*(z-this.z)>=.25){idle=0;this.x=x;this.y=y;this.z=z;}else idle++;
  return idle>=idleLimit||withoutProof>=proofLimit;
 }
}
