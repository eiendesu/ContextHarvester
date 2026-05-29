using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using System.Collections.Generic;
using System.Linq;

namespace RoslynHarvester;

public class SemanticResolver
{
    private readonly Compilation _compilation;

    public SemanticResolver(Compilation compilation)
    {
        _compilation = compilation;
    }

    public List<ResolvedCallEdge> ResolveUnresolved(List<RawCallEdge> unresolvedCalls)
    {
        var resolved = new List<ResolvedCallEdge>();

        foreach (var call in unresolvedCalls)
        {
            var tree = _compilation.SyntaxTrees
                .FirstOrDefault(t => t.FilePath == call.FromFile);
            if (tree == null) continue;

            var semanticModel = _compilation.GetSemanticModel(tree);
            var root = tree.GetRoot();

            // Trova l'invocation corrispondente (per file + metodo + riga)
            var invocation = root.DescendantNodes()
                .OfType<InvocationExpressionSyntax>()
                .FirstOrDefault(i =>
                    i.GetLocation().GetLineSpan()
                     .StartLinePosition.Line == call.Line - 1);

            if (invocation == null) continue;

            var symbolInfo = semanticModel.GetSymbolInfo(invocation);
            var targetSymbol = symbolInfo.Symbol as IMethodSymbol;

            if (targetSymbol == null) continue;

            // Solo simboli definiti nel nostro assembly
            if (!SymbolEqualityComparer.Default.Equals(
                    targetSymbol.ContainingAssembly,
                    _compilation.Assembly)) continue;

            var targetFile = targetSymbol.Locations
                .FirstOrDefault()?.SourceTree?.FilePath;

            if (targetFile == null) continue;

            resolved.Add(new ResolvedCallEdge
            {
                FromFile = call.FromFile,
                FromClass = call.FromClass,
                FromMethod = call.FromMethod,
                ToFile = targetFile,
                ToClass = targetSymbol.ContainingType.Name,
                ToMethod = targetSymbol.Name,
                Line = call.Line,
                ResolvedBy = "roslyn_semantic"
            });
        }

        return resolved;
    }
}

public class ResolvedCallEdge
{
    public string FromFile { get; set; } = "";
    public string FromClass { get; set; } = "";
    public string FromMethod { get; set; } = "";
    public string ToFile { get; set; } = "";
    public string ToClass { get; set; } = "";
    public string ToMethod { get; set; } = "";
    public int Line { get; set; }
    public string ResolvedBy { get; set; } = "";
}
