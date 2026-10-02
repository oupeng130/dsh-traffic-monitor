// dsh-traffic-monitor — Windows 采集核心（由 collector.ps1 通过 Add-Type 编译）。
//
// 这个文件是插件里唯一碰 Win32 的地方，它只做四件事：
//   1. 读 TCP/UDP 连接表（GetExtendedTcpTable / GetExtendedUdpTable）——拿 PID 与端点，
//      普通用户即可，不需要任何特权；
//   2. 给每条 TCP 连接打开扩展统计（SetPerTcpConnectionEStats）——**必须 UAC 提权**，
//      这是 Windows 上按连接给出收发字节数的唯一用户态接口；
//   3. 读回每条连接的累计收发字节（GetPerTcpConnectionEStats → TCP_ESTATS_DATA_ROD_v0，
//      对应 RFC 4898 的 tcpEStatsPerfDataOctetsIn/Out）；
//   4. 把能力如实报出去：提权了没有、字节有没有读到、被拒绝了多少条。
//
// 没有驱动、没有抓包、没有 ETW 会话：字节数来自 TCP/IP 栈自己维护的每连接计数器。
// 代价是只覆盖 TCP——UDP（含 QUIC/HTTP3、DNS）没有对应的用户态接口，如实记为「无字节」。
using System;
using System.Collections.Generic;
using System.Net;
using System.Runtime.InteropServices;

public static class DshTrafficProbe
{
    // ── 表结构 ────────────────────────────────────────────────────────────────
    [StructLayout(LayoutKind.Sequential)]
    public struct MIB_TCPROW_OWNER_PID
    {
        public uint dwState;
        public uint dwLocalAddr;
        public uint dwLocalPort;
        public uint dwRemoteAddr;
        public uint dwRemotePort;
        public uint dwOwningPid;
    }

    /// <summary>
    /// 56 字节：实测（与 netstat 对照）这一行是 「地址/端口 + 状态 + PID」，
    /// 与 SDK 头文件里那个 52 字节的定义差一个 dwState——以本机实测为准。
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct MIB_TCP6ROW_OWNER_PID
    {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] ucLocalAddr;
        public uint dwLocalScopeId;
        public uint dwLocalPort;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] ucRemoteAddr;
        public uint dwRemoteScopeId;
        public uint dwRemotePort;
        public uint dwState;
        public uint dwOwningPid;
    }

    /// <summary>
    /// EStats 的 IPv6 行定义（tcpmib.h）：<b>State 在最前面</b>，然后才是地址与端口。
    /// 这跟连接表里那个 56 字节的 OWNER_PID 行字段顺序不同——照表行的顺序传进去，
    /// 内核拿首字段当地址去查连接，查不到，回 ERROR_NO_SYSTEM_RESOURCES(1214)。
    /// 这正是本机实测踩到的坑，字段顺序以 tcpmib.h 为准。
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct MIB_TCP6ROW
    {
        public uint State;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] LocalAddr;
        public uint dwLocalScopeId;
        public uint dwLocalPort;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] RemoteAddr;
        public uint dwRemoteScopeId;
        public uint dwRemotePort;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MIB_UDPROW_OWNER_PID
    {
        public uint dwLocalAddr;
        public uint dwLocalPort;
        public uint dwOwningPid;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MIB_UDP6ROW_OWNER_PID
    {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] ucLocalAddr;
        public uint dwLocalScopeId;
        public uint dwLocalPort;
        public uint dwOwningPid;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct TCP_ESTATS_DATA_RW_v0
    {
        public byte EnableCollection;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct TCP_ESTATS_DATA_ROD_v0
    {
        public ulong DataBytesOut;
        public ulong DataSegsOut;
        public ulong DataBytesIn;
        public ulong DataSegsIn;
        public ulong SegsOut;
        public ulong SegsIn;
        public uint SoftErrors;
        public uint SoftErrorReason;
        public uint SndUna;
        public uint SndNxt;
        public uint SndMax;
        public ulong ThruBytesAcked;
        public uint RcvNxt;
        public ulong ThruBytesReceived;
    }

    // ── P/Invoke ──────────────────────────────────────────────────────────────
    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(IntPtr pTcpTable, ref int pdwSize, bool bOrder, int ulAf, int tableClass, uint reserved);

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedUdpTable(IntPtr pUdpTable, ref int pdwSize, bool bOrder, int ulAf, int tableClass, uint reserved);

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint SetPerTcpConnectionEStats(ref MIB_TCPROW_OWNER_PID Row, int EstatsType, ref TCP_ESTATS_DATA_RW_v0 Rw, uint RwVersion, uint RwSize, int Offset);

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetPerTcpConnectionEStats(ref MIB_TCPROW_OWNER_PID Row, int EstatsType, IntPtr Rw, uint RwVersion, uint RwSize, IntPtr Ros, uint RosVersion, uint RosSize, IntPtr Rod, uint RodVersion, uint RodSize);

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint SetPerTcp6ConnectionEStats(ref MIB_TCP6ROW Row, int EstatsType, ref TCP_ESTATS_DATA_RW_v0 Rw, uint RwVersion, uint RwSize, int Offset);

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetPerTcp6ConnectionEStats(ref MIB_TCP6ROW Row, int EstatsType, IntPtr Rw, uint RwVersion, uint RwSize, IntPtr Ros, uint RosVersion, uint RosSize, IntPtr Rod, uint RodVersion, uint RodSize);

    private const int AF_INET = 2;
    private const int AF_INET6 = 23;
    /// <summary>MIB_TCP_TABLE_CLASS: TCP_TABLE_OWNER_PID_CONNECTIONS —— 只要连接，不要监听。</summary>
    private const int TABLE_OWNER_PID_CONNECTIONS = 4;
    private const int ESTATS_TYPE_DATA = 1;
    private const uint NO_ERROR = 0;
    private const uint ERROR_ACCESS_DENIED = 5;

    // ── 状态 ──────────────────────────────────────────────────────────────────
    private static readonly HashSet<string> _enabled = new HashSet<string>();
    private static bool _denied;
    private static int _lastV4Code;
    private static int _lastV6Code;
    private static int _enabledV4;
    private static int _enabledV6;

    private static int RodSize = Marshal.SizeOf(typeof(TCP_ESTATS_DATA_ROD_v0));
    private static int RwSize = Marshal.SizeOf(typeof(TCP_ESTATS_DATA_RW_v0));

    private static string Ip4(uint value)
    {
        // MIB 按网络字节序存、按小端读出来，两者正好抵消：GetBytes 直接就是网络序。
        return new IPAddress(BitConverter.GetBytes(value)).ToString();
    }

    private static string Ip6(byte[] addr, uint scope)
    {
        if (addr == null || addr.Length != 16) return "::";
        try { return new IPAddress(addr).ToString(); }
        catch { return "::"; }
    }

    /// <summary>MIB 的端口字段按网络字节序存，读出来是字节反了的。</summary>
    private static int Port(uint networkValue)
    {
        return (int)(((networkValue & 0xFF) << 8) | ((networkValue >> 8) & 0xFF));
    }

    private static string Key(int family, string local, int localPort, string remote, int remotePort)
    {
        return family + "|" + local + ":" + localPort + "|" + remote + ":" + remotePort;
    }

    private static List<Dictionary<string, object>> ReadRows(int family, out int tableError)
    {
        var result = new List<Dictionary<string, object>>();
        tableError = 0;
        int size = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, TABLE_OWNER_PID_CONNECTIONS, 0);
        if (size <= 0) return result;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            uint rc = GetExtendedTcpTable(buffer, ref size, false, family, TABLE_OWNER_PID_CONNECTIONS, 0);
            if (rc != NO_ERROR) { tableError = (int)rc; return result; }
            int count = Marshal.ReadInt32(buffer);
            int stride = family == AF_INET ? 24 : 56;
            for (int i = 0; i < count; i++)
            {
                IntPtr p = IntPtr.Add(buffer, 4 + i * stride);
                if (family == AF_INET)
                {
                    var row = Marshal.PtrToStructure<MIB_TCPROW_OWNER_PID>(p);
                    string local = Ip4(row.dwLocalAddr);
                    string remote = Ip4(row.dwRemoteAddr);
                    int lp = Port(row.dwLocalPort);
                    int rp = Port(row.dwRemotePort);
                    result.Add(new Dictionary<string, object>
                    {
                        { "key", Key(AF_INET, local, lp, remote, rp) },
                        { "pid", (int)row.dwOwningPid },
                        { "fam", 4 },
                        { "l", local + ":" + lp },
                        { "r", remote + ":" + rp },
                        { "state", (int)row.dwState },
                        // 原始字段留给 EStats 调用（Key 是字符串，反解不回去）
                        { "_state", row.dwState },
                        { "_la", row.dwLocalAddr },
                        { "_lp", row.dwLocalPort },
                        { "_ra", row.dwRemoteAddr },
                        { "_rp", row.dwRemotePort },
                        { "_pid", row.dwOwningPid },
                    });
                }
                else
                {
                    var row = Marshal.PtrToStructure<MIB_TCP6ROW_OWNER_PID>(p);
                    string local = Ip6(row.ucLocalAddr, row.dwLocalScopeId);
                    string remote = Ip6(row.ucRemoteAddr, row.dwRemoteScopeId);
                    int lp = Port(row.dwLocalPort);
                    int rp = Port(row.dwRemotePort);
                    result.Add(new Dictionary<string, object>
                    {
                        { "key", Key(AF_INET6, local, lp, remote, rp) },
                        { "pid", (int)row.dwOwningPid },
                        { "fam", 6 },
                        { "l", "[" + local + "]:" + lp },
                        { "r", "[" + remote + "]:" + rp },
                        { "state", (int)row.dwState },
                        { "_la6", row.ucLocalAddr },
                        { "_lscope", row.dwLocalScopeId },
                        { "_lp", row.dwLocalPort },
                        { "_ra6", row.ucRemoteAddr },
                        { "_rscope", row.dwRemoteScopeId },
                        { "_rp", row.dwRemotePort },
                        { "_state", row.dwState },
                        { "_pid", row.dwOwningPid },
                    });
                }
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
        return result;
    }

    private static List<Dictionary<string, object>> ReadUdpRows(int family)
    {
        var result = new List<Dictionary<string, object>>();
        int size = 0;
        GetExtendedUdpTable(IntPtr.Zero, ref size, false, family, 1 /* UDP_TABLE_OWNER_PID */, 0);
        if (size <= 0) return result;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            uint rc = GetExtendedUdpTable(buffer, ref size, false, family, 1, 0);
            if (rc != NO_ERROR) return result;
            int count = Marshal.ReadInt32(buffer);
            int stride = family == AF_INET ? 12 : 28;
            for (int i = 0; i < count; i++)
            {
                IntPtr p = IntPtr.Add(buffer, 4 + i * stride);
                if (family == AF_INET)
                {
                    var row = Marshal.PtrToStructure<MIB_UDPROW_OWNER_PID>(p);
                    result.Add(new Dictionary<string, object>
                    {
                        { "pid", (int)row.dwOwningPid },
                        { "fam", 4 },
                        { "l", Ip4(row.dwLocalAddr) + ":" + Port(row.dwLocalPort) },
                    });
                }
                else
                {
                    var row = Marshal.PtrToStructure<MIB_UDP6ROW_OWNER_PID>(p);
                    result.Add(new Dictionary<string, object>
                    {
                        { "pid", (int)row.dwOwningPid },
                        { "fam", 6 },
                        { "l", "[" + Ip6(row.ucLocalAddr, row.dwLocalScopeId) + "]:" + Port(row.dwLocalPort) },
                    });
                }
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
        return result;
    }

    /// <summary>
    /// 打开一条连接的字节计数。返回 NO_ERROR 表示成功（通常只有提权后的进程能做到）。
    /// </summary>
    private static uint EnableV4(Dictionary<string, object> row)
    {
        // 从 key 反解端口是错的，这里重新按原始字段拼——调用方直接传行数据即可。
        // 为了拿到原始行，ReadRows 把原始值一并放进了 row。
        var native = new MIB_TCPROW_OWNER_PID
        {
            dwState = Convert.ToUInt32(row["_state"]),
            dwLocalAddr = Convert.ToUInt32(row["_la"]),
            dwLocalPort = Convert.ToUInt32(row["_lp"]),
            dwRemoteAddr = Convert.ToUInt32(row["_ra"]),
            dwRemotePort = Convert.ToUInt32(row["_rp"]),
            dwOwningPid = Convert.ToUInt32(row["_pid"]),
        };
        var rw = new TCP_ESTATS_DATA_RW_v0 { EnableCollection = 1 };
        return SetPerTcpConnectionEStats(ref native, ESTATS_TYPE_DATA, ref rw, 0, (uint)RwSize, 0);
    }

    private static uint EnableV6(Dictionary<string, object> row)
    {
        var native = Native6Of(row);
        var rw = new TCP_ESTATS_DATA_RW_v0 { EnableCollection = 1 };
        return SetPerTcp6ConnectionEStats(ref native, ESTATS_TYPE_DATA, ref rw, 0, (uint)RwSize, 0);
    }

    /// <summary>把一行 IPv6 快照还原成 EStats 要的 MIB_TCP6ROW（State 在最前）。</summary>
    private static MIB_TCP6ROW Native6Of(Dictionary<string, object> row)
    {
        return new MIB_TCP6ROW
        {
            State = Convert.ToUInt32(row["_state"]),
            LocalAddr = (byte[])row["_la6"],
            dwLocalScopeId = Convert.ToUInt32(row["_lscope"]),
            dwLocalPort = Convert.ToUInt32(row["_lp"]),
            RemoteAddr = (byte[])row["_ra6"],
            dwRemoteScopeId = Convert.ToUInt32(row["_rscope"]),
            dwRemotePort = Convert.ToUInt32(row["_rp"]),
        };
    }

    private static bool TryReadV4(Dictionary<string, object> row, out ulong bytesOut, out ulong bytesIn)
    {
        bytesOut = 0; bytesIn = 0;
        var native = new MIB_TCPROW_OWNER_PID
        {
            dwState = Convert.ToUInt32(row["_state"]),
            dwLocalAddr = Convert.ToUInt32(row["_la"]),
            dwLocalPort = Convert.ToUInt32(row["_lp"]),
            dwRemoteAddr = Convert.ToUInt32(row["_ra"]),
            dwRemotePort = Convert.ToUInt32(row["_rp"]),
            dwOwningPid = Convert.ToUInt32(row["_pid"]),
        };
        IntPtr rwBuf = Marshal.AllocHGlobal(RwSize);
        IntPtr rodBuf = Marshal.AllocHGlobal(RodSize);
        try
        {
            for (int i = 0; i < RwSize; i++) Marshal.WriteByte(rwBuf, i, 0);
            uint rc = GetPerTcpConnectionEStats(ref native, ESTATS_TYPE_DATA, rwBuf, 0, (uint)RwSize, IntPtr.Zero, 0, 0, rodBuf, 0, (uint)RodSize);
            if (rc != NO_ERROR) return false;
            if (Marshal.ReadByte(rwBuf, 0) != 1) return false;
            var rod = Marshal.PtrToStructure<TCP_ESTATS_DATA_ROD_v0>(rodBuf);
            bytesOut = rod.DataBytesOut;
            bytesIn = rod.DataBytesIn;
            return true;
        }
        finally { Marshal.FreeHGlobal(rwBuf); Marshal.FreeHGlobal(rodBuf); }
    }

    private static bool TryReadV6(Dictionary<string, object> row, out ulong bytesOut, out ulong bytesIn)
    {
        bytesOut = 0; bytesIn = 0;
        var native = Native6Of(row);
        IntPtr rwBuf = Marshal.AllocHGlobal(RwSize);
        IntPtr rodBuf = Marshal.AllocHGlobal(RodSize);
        try
        {
            for (int i = 0; i < RwSize; i++) Marshal.WriteByte(rwBuf, i, 0);
            uint rc = GetPerTcp6ConnectionEStats(ref native, ESTATS_TYPE_DATA, rwBuf, 0, (uint)RwSize, IntPtr.Zero, 0, 0, rodBuf, 0, (uint)RodSize);
            if (rc != NO_ERROR) return false;
            if (Marshal.ReadByte(rwBuf, 0) != 1) return false;
            var rod = Marshal.PtrToStructure<TCP_ESTATS_DATA_ROD_v0>(rodBuf);
            bytesOut = rod.DataBytesOut;
            bytesIn = rod.DataBytesIn;
            return true;
        }
        finally { Marshal.FreeHGlobal(rwBuf); Marshal.FreeHGlobal(rodBuf); }
    }

    /// <summary>
    /// 一轮快照：连接表 + （若已提权）每连接的累计收发字节。
    /// 返回的对象交给 PowerShell 的 ConvertTo-Json 序列化。
    /// </summary>
    public static Dictionary<string, object> Snapshot()
    {
        var tcp = new List<Dictionary<string, object>>();
        int err4, err6;
        var raw4 = ReadRows(AF_INET, out err4);
        var raw6 = ReadRows(AF_INET6, out err6);

        bool attempt = !_denied;
        int enabledV4 = 0, enabledV6 = 0, deniedV4 = 0, deniedV6 = 0, byteRows = 0;

        foreach (var row in raw4)
        {
            string key = (string)row["key"];
            bool active = (int)row["state"] == 5;
            if (active && !_enabled.Contains(key))
            {
                if (attempt)
                {
                    uint rc = EnableV4(row);
                    if (rc == NO_ERROR) { _enabled.Add(key); _enabledV4++; _lastV4Code = 0; }
                    else
                    {
                        _lastV4Code = (int)rc;
                        if (rc == ERROR_ACCESS_DENIED) { _denied = true; deniedV4++; attempt = false; }
                    }
                }
            }
            if (_enabled.Contains(key))
            {
                enabledV4++;
                ulong o4, n4;
                if (TryReadV4(row, out o4, out n4))
                {
                    row["out"] = o4; row["in"] = n4; byteRows++;
                }
                else _enabled.Remove(key);
            }
            StripNative(row);
            tcp.Add(row);
        }

        if (!_denied) attempt = true;
        foreach (var row in raw6)
        {
            string key = (string)row["key"];
            bool active6 = (int)row["state"] == 5;
            if (active6 && !_enabled.Contains(key))
            {
                if (attempt)
                {
                    uint rc = EnableV6(row);
                    if (rc == NO_ERROR) { _enabled.Add(key); _enabledV6++; _lastV6Code = 0; }
                    else
                    {
                        _lastV6Code = (int)rc;
                        if (rc == ERROR_ACCESS_DENIED) { _denied = true; deniedV6++; attempt = false; }
                    }
                }
            }
            if (_enabled.Contains(key))
            {
                enabledV6++;
                ulong o6, n6;
                if (TryReadV6(row, out o6, out n6))
                {
                    row["out"] = o6; row["in"] = n6; byteRows++;
                }
                else _enabled.Remove(key);
            }
            StripNative(row);
            tcp.Add(row);
        }

        // 连接关掉之后它的 key 就没用了：每轮按存活集合裁一次，避免这张表无限长。
        var live = new HashSet<string>();
        foreach (var r in tcp) live.Add((string)r["key"]);
        _enabled.IntersectWith(live);

        var udp = new List<Dictionary<string, object>>();
        udp.AddRange(ReadUdpRows(AF_INET));
        udp.AddRange(ReadUdpRows(AF_INET6));

        string estats;
        if (_denied && byteRows == 0) estats = "denied";
        else if (byteRows > 0) estats = byteRows < (_enabledV4 + _enabledV6) ? "partial" : "ok";
        else estats = "off";

        return new Dictionary<string, object>
        {
            { "tcp", tcp },
            { "udp", udp },
            { "caps", new Dictionary<string, object>
                {
                    { "elevated", IsElevated() },
                    { "estats", estats },
                    { "byteRows", byteRows },
                    { "enabledV4", _enabledV4 },
                    { "enabledV6", _enabledV6 },
                    { "tracked", _enabled.Count },
                    { "lastV4Code", _lastV4Code },
                    { "lastV6Code", _lastV6Code },
                    { "tableV4Code", err4 },
                    { "tableV6Code", err6 },
                }
            },
        };
    }

    private static void StripNative(Dictionary<string, object> row)
    {
        row.Remove("_state"); row.Remove("_la"); row.Remove("_lp");
        row.Remove("_ra"); row.Remove("_rp"); row.Remove("_la6");
        row.Remove("_ra6"); row.Remove("_lscope"); row.Remove("_rscope");
        row.Remove("_pid");
    }

    public static bool IsElevated()
    {
        try
        {
            using (var id = System.Security.Principal.WindowsIdentity.GetCurrent())
            {
                return new System.Security.Principal.WindowsPrincipal(id)
                    .IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
        }
        catch { return false; }
    }
}
