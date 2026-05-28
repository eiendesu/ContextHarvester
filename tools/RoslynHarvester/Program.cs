using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using System.Collections.Generic;

if (args.Length < 1)
{
    Console.Error.WriteLine("Usage: RoslynHarvester <repoPath> [relativeFile.cs ...]");
    Environment.Exit(2);
}

var repoRoot = Path.GetFullPath(args[0]);
var onlyFiles = args.Length > 1 ? args.Skip(1).ToHashSet(StringComparer.OrdinalIgnoreCase) : null;

var result = new ScanResult();

IEnumerable<string> EnumerateFilesSafe(string root)
{
    var stack = new Stack<string>();
    stack.Push(root);
    while (stack.Count > 0)
    {
        var dir = stack.Pop();
        string[] files = null;
        try
        {
            files = Directory.GetFiles(dir, "*.cs");
        }
        catch
        {
            continue;
        }
        foreach (var f in files)
            yield return f;
        string[] subs = null;
        try
        {
            subs = Directory.GetDirectories(dir);
        }
        catch
        {
            continue;
        }
        foreach (var s in subs)
            stack.Push(s);
    }
}

foreach (var file in EnumerateFilesSafe(repoRoot))
{
    var rel = Path.GetRelativePath(repoRoot, file).Replace('\\', '/');
    if (rel.Contains("/bin/", StringComparison.OrdinalIgnoreCase) ||
        rel.Contains("/obj/", StringComparison.OrdinalIgnoreCase) ||
        rel.Contains("\\bin\\", StringComparison.OrdinalIgnoreCase) ||
        rel.Contains("\\obj\\", StringComparison.OrdinalIgnoreCase))
        continue;
    if (onlyFiles != null && !onlyFiles.Contains(rel))
        continue;

    string text;
    try
    {
        text = File.ReadAllText(file);
    }
    catch
    {
        continue;
    }

    var tree = CSharpSyntaxTree.ParseText(text, path: rel);
    var root = tree.GetRoot();
    var fileEntry = new FileEntry { Path = rel };

    foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
    {
        var className = cls.Identifier.Text;
        var line = cls.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
        var kind = IsDtoName(className) ? "dto" : "class";
        var classRoute = ExtractRoute(cls.AttributeLists);
        fileEntry.Classes.Add(new ClassEntry
        {
            Name = className,
            Kind = kind,
            Line = line,
            Route = classRoute,
            IsController = className.EndsWith("Controller", StringComparison.Ordinal),
        });

        foreach (var method in cls.Members.OfType<MethodDeclarationSyntax>())
        {
            var mName = method.Identifier.Text;
            if (mName is "Main" or "Dispose")
                continue;
            var mLine = method.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
            var vis = method.Modifiers.Any(SyntaxKind.PublicKeyword) ? "public" :
                method.Modifiers.Any(SyntaxKind.PrivateKeyword) ? "private" : "internal";
            fileEntry.Methods.Add(new MethodEntry
            {
                ClassName = className,
                Name = mName,
                Line = mLine,
                Visibility = vis,
                QualifiedName = $"{className}.{mName}",
            });

            if (className.EndsWith("Controller", StringComparison.Ordinal))
            {
                var http = ExtractHttpMethod(method.AttributeLists);
                var actionRoute = ExtractRoute(method.AttributeLists);
                if (http != null || actionRoute != null)
                {
                    fileEntry.Endpoints.Add(new EndpointEntry
                    {
                        Controller = className,
                        Action = mName,
                        Method = http ?? "GET",
                        ActionRoute = actionRoute ?? "",
                        ClassRoute = classRoute ?? "",
                        Line = mLine,
                        QualifiedName = $"{className}.{mName}",
                    });
                }
            }
        }
    }

    if (fileEntry.Classes.Count > 0 || fileEntry.Methods.Count > 0)
        result.Files.Add(fileEntry);
}

var json = JsonSerializer.Serialize(
    result,
    new JsonSerializerOptions { WriteIndented = false, PropertyNamingPolicy = JsonNamingPolicy.CamelCase }
);
Console.WriteLine(json);

static bool IsDtoName(string name) =>
    name.EndsWith("Dto", StringComparison.OrdinalIgnoreCase) ||
    name.EndsWith("DTO", StringComparison.Ordinal) ||
    name.EndsWith("Request", StringComparison.OrdinalIgnoreCase) ||
    name.EndsWith("Response", StringComparison.OrdinalIgnoreCase) ||
    name.EndsWith("Model", StringComparison.OrdinalIgnoreCase);

static string? ExtractRoute(SyntaxList<AttributeListSyntax> lists)
{
    foreach (var al in lists)
    {
        foreach (var attr in al.Attributes)
        {
            var name = attr.Name.ToString();
            if (!name.Contains("Route", StringComparison.Ordinal))
                continue;
            if (attr.ArgumentList?.Arguments.FirstOrDefault()?.Expression is LiteralExpressionSyntax lit)
                return lit.Token.ValueText;
        }
    }
    return null;
}

static string? ExtractHttpMethod(SyntaxList<AttributeListSyntax> lists)
{
    foreach (var al in lists)
    {
        foreach (var attr in al.Attributes)
        {
            var name = attr.Name.ToString();
            if (name.Contains("HttpGet", StringComparison.Ordinal)) return "GET";
            if (name.Contains("HttpPost", StringComparison.Ordinal)) return "POST";
            if (name.Contains("HttpPut", StringComparison.Ordinal)) return "PUT";
            if (name.Contains("HttpDelete", StringComparison.Ordinal)) return "DELETE";
            if (name.Contains("HttpPatch", StringComparison.Ordinal)) return "PATCH";
        }
    }
    return null;
}

sealed class ScanResult
{
    public List<FileEntry> Files { get; set; } = new();
}

sealed class FileEntry
{
    public string Path { get; set; } = "";
    public List<ClassEntry> Classes { get; set; } = new();
    public List<MethodEntry> Methods { get; set; } = new();
    public List<EndpointEntry> Endpoints { get; set; } = new();
}

sealed class ClassEntry
{
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "class";
    public int Line { get; set; }
    public string? Route { get; set; }
    public bool IsController { get; set; }
}

sealed class MethodEntry
{
    public string ClassName { get; set; } = "";
    public string Name { get; set; } = "";
    public int Line { get; set; }
    public string Visibility { get; set; } = "public";
    public string QualifiedName { get; set; } = "";
}

sealed class EndpointEntry
{
    public string Controller { get; set; } = "";
    public string Action { get; set; } = "";
    public string Method { get; set; } = "GET";
    public string ActionRoute { get; set; } = "";
    public string ClassRoute { get; set; } = "";
    public int Line { get; set; }
    public string QualifiedName { get; set; } = "";
}
