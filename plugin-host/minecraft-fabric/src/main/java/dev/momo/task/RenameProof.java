package dev.momo.task;
import java.util.Map;
/** Client prediction needs the corresponding actual server output-slot update. */
public final class RenameProof {
 public static boolean matches(String requested,String actualName,String fingerprint,Map<Integer,String> serverChanges){return requested.equals(actualName)&&fingerprint.equals(serverChanges.get(2));}
}
