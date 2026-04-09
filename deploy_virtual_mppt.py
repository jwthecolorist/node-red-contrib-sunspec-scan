import paramiko
import os

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
print("Connecting to einstein...")
ssh.connect("einstein", username="root", password="FRANKSCERBO*", timeout=15)

try:
    sftp = ssh.open_sftp()
    
    # 1. Create service directory
    ssh.exec_command("mkdir -p /data/dbus-virtual-mppt/log")
    
    # 2. Upload Python script
    local_mppt = "dbus-virtual-mppt/dbus-virtual-mppt.py"
    remote_mppt = "/data/dbus-virtual-mppt/dbus-virtual-mppt.py"
    print(f"Uploading {local_mppt} -> {remote_mppt}")
    sftp.put(local_mppt, remote_mppt)
    
    # 3. Create run script for daemon
    run_script = '''#!/bin/sh
exec 2>&1
exec python3 /data/dbus-virtual-mppt/dbus-virtual-mppt.py
'''
    with sftp.open("/data/dbus-virtual-mppt/run", "w") as f:
        f.write(run_script)
        
    # 4. Create log run script
    log_run = '''#!/bin/sh
exec 2>&1
exec multilog t s100000 n2 /var/log/dbus-virtual-mppt
'''
    with sftp.open("/data/dbus-virtual-mppt/log/run", "w") as f:
        f.write(log_run)
        
    sftp.close()
    
    # 5. Set executable permissions
    ssh.exec_command("chmod +x /data/dbus-virtual-mppt/run")
    ssh.exec_command("chmod +x /data/dbus-virtual-mppt/log/run")
    
    # 6. Link to daemontools
    ssh.exec_command("ln -sf /data/dbus-virtual-mppt /service/dbus-virtual-mppt")
    
    # 7. Restart service
    ssh.exec_command("svc -t /service/dbus-virtual-mppt")
    
    print("Virtual MPPT Successfully Deployed and Started!")

except Exception as e:
    print(f"Deployment failed: {e}")
finally:
    ssh.close()
